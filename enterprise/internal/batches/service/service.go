package service

import (
	"context"
	"fmt"
	"time"

	"github.com/cockroachdb/errors"
	"github.com/graph-gophers/graphql-go"

	"github.com/sourcegraph/sourcegraph/cmd/frontend/backend"
	"github.com/sourcegraph/sourcegraph/cmd/frontend/graphqlbackend"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/batches/global"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/batches/sources"
	"github.com/sourcegraph/sourcegraph/enterprise/internal/batches/store"
	btypes "github.com/sourcegraph/sourcegraph/enterprise/internal/batches/types"
	"github.com/sourcegraph/sourcegraph/internal/actor"
	"github.com/sourcegraph/sourcegraph/internal/api"
	"github.com/sourcegraph/sourcegraph/internal/database"
	"github.com/sourcegraph/sourcegraph/internal/extsvc/auth"
	"github.com/sourcegraph/sourcegraph/internal/httpcli"
	"github.com/sourcegraph/sourcegraph/internal/repoupdater"
	"github.com/sourcegraph/sourcegraph/internal/trace"
	"github.com/sourcegraph/sourcegraph/internal/types"
	batcheslib "github.com/sourcegraph/sourcegraph/lib/batches"
)

// New returns a Service.
func New(store *store.Store) *Service {
	return NewWithClock(store, store.Clock())
}

// NewWithClock returns a Service the given clock used
// to generate timestamps.
func NewWithClock(store *store.Store, clock func() time.Time) *Service {
	svc := &Service{store: store, sourcer: sources.NewSourcer(httpcli.ExternalClientFactory), clock: clock}

	return svc
}

type Service struct {
	store *store.Store

	sourcer sources.Sourcer

	clock func() time.Time
}

// WithStore returns a copy of the Service with its store attribute set to the
// given Store.
func (s *Service) WithStore(store *store.Store) *Service {
	return &Service{store: store, sourcer: s.sourcer, clock: s.clock}
}

type CreateBatchSpecOpts struct {
	RawSpec string `json:"raw_spec"`

	NamespaceUserID int32 `json:"namespace_user_id"`
	NamespaceOrgID  int32 `json:"namespace_org_id"`

	ChangesetSpecRandIDs []string `json:"changeset_spec_rand_ids"`
}

// CreateBatchSpec creates the BatchSpec.
func (s *Service) CreateBatchSpec(ctx context.Context, opts CreateBatchSpecOpts) (spec *btypes.BatchSpec, err error) {
	actor := actor.FromContext(ctx)
	tr, ctx := trace.New(ctx, "Service.CreateBatchSpec", fmt.Sprintf("Actor %s", actor))
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	spec, err = btypes.NewBatchSpecFromRaw(opts.RawSpec)
	if err != nil {
		return nil, err
	}

	// Check whether the current user has access to either one of the namespaces.
	err = s.CheckNamespaceAccess(ctx, opts.NamespaceUserID, opts.NamespaceOrgID)
	if err != nil {
		return nil, err
	}
	spec.NamespaceOrgID = opts.NamespaceOrgID
	spec.NamespaceUserID = opts.NamespaceUserID
	spec.UserID = actor.UID

	if len(opts.ChangesetSpecRandIDs) == 0 {
		return spec, s.store.CreateBatchSpec(ctx, spec)
	}

	listOpts := store.ListChangesetSpecsOpts{RandIDs: opts.ChangesetSpecRandIDs}
	cs, _, err := s.store.ListChangesetSpecs(ctx, listOpts)
	if err != nil {
		return nil, err
	}

	// 🚨 SECURITY: database.Repos.GetRepoIDsSet uses the authzFilter under the hood and
	// filters out repositories that the user doesn't have access to.
	accessibleReposByID, err := s.store.Repos().GetReposSetByIDs(ctx, cs.RepoIDs()...)
	if err != nil {
		return nil, err
	}

	byRandID := make(map[string]*btypes.ChangesetSpec, len(cs))
	for _, changesetSpec := range cs {
		// 🚨 SECURITY: We return an error if the user doesn't have access to one
		// of the repositories associated with a ChangesetSpec.
		if _, ok := accessibleReposByID[changesetSpec.RepoID]; !ok {
			return nil, &database.RepoNotFoundErr{ID: changesetSpec.RepoID}
		}
		byRandID[changesetSpec.RandID] = changesetSpec
	}

	// Check if a changesetSpec was not found
	for _, randID := range opts.ChangesetSpecRandIDs {
		if _, ok := byRandID[randID]; !ok {
			return nil, &changesetSpecNotFoundErr{RandID: randID}
		}
	}

	tx, err := s.store.Transact(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { err = tx.Done(err) }()

	if err := tx.CreateBatchSpec(ctx, spec); err != nil {
		return nil, err
	}

	for _, changesetSpec := range cs {
		changesetSpec.BatchSpecID = spec.ID

		if err := tx.UpdateChangesetSpec(ctx, changesetSpec); err != nil {
			return nil, err
		}
	}

	return spec, nil
}

// CreateChangesetSpec validates the given raw spec input and creates the ChangesetSpec.
func (s *Service) CreateChangesetSpec(ctx context.Context, rawSpec string, userID int32) (spec *btypes.ChangesetSpec, err error) {
	tr, ctx := trace.New(ctx, "Service.CreateChangesetSpec", fmt.Sprintf("User %d", userID))
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	spec, err = btypes.NewChangesetSpecFromRaw(rawSpec)
	if err != nil {
		return nil, err
	}
	spec.UserID = userID
	spec.RepoID, err = graphqlbackend.UnmarshalRepositoryID(graphql.ID(spec.Spec.BaseRepository))
	if err != nil {
		return nil, err
	}

	// 🚨 SECURITY: We use database.Repos.Get to check whether the user has access to
	// the repository or not.
	if _, err = s.store.Repos().Get(ctx, spec.RepoID); err != nil {
		return nil, err
	}

	return spec, s.store.CreateChangesetSpec(ctx, spec)
}

// changesetSpecNotFoundErr is returned by CreateBatchSpec if a
// ChangesetSpec with the given RandID doesn't exist.
// It fulfills the interface required by errcode.IsNotFound.
type changesetSpecNotFoundErr struct {
	RandID string
}

func (e *changesetSpecNotFoundErr) Error() string {
	if e.RandID != "" {
		return fmt.Sprintf("changesetSpec not found: id=%s", e.RandID)
	}
	return "changesetSpec not found"
}

func (e *changesetSpecNotFoundErr) NotFound() bool { return true }

// GetBatchChangeMatchingBatchSpec returns the batch change that the BatchSpec
// applies to, if that BatchChange already exists.
// If it doesn't exist yet, both return values are nil.
// It accepts a *store.Store so that it can be used inside a transaction.
func (s *Service) GetBatchChangeMatchingBatchSpec(ctx context.Context, spec *btypes.BatchSpec) (*btypes.BatchChange, error) {
	opts := store.GetBatchChangeOpts{
		Name:            spec.Spec.Name,
		NamespaceUserID: spec.NamespaceUserID,
		NamespaceOrgID:  spec.NamespaceOrgID,
	}

	batchChange, err := s.store.GetBatchChange(ctx, opts)
	if err != nil {
		if err != store.ErrNoResults {
			return nil, err
		}
		err = nil
	}
	return batchChange, err
}

// GetNewestBatchSpec returns the newest batch spec that matches the given
// spec's namespace and name and is owned by the given user, or nil if none is found.
func (s *Service) GetNewestBatchSpec(ctx context.Context, tx *store.Store, spec *btypes.BatchSpec, userID int32) (*btypes.BatchSpec, error) {
	opts := store.GetNewestBatchSpecOpts{
		UserID:          userID,
		NamespaceUserID: spec.NamespaceUserID,
		NamespaceOrgID:  spec.NamespaceOrgID,
		Name:            spec.Spec.Name,
	}

	newest, err := tx.GetNewestBatchSpec(ctx, opts)
	if err != nil {
		if err != store.ErrNoResults {
			return nil, err
		}
		return nil, nil
	}

	return newest, nil
}

type MoveBatchChangeOpts struct {
	BatchChangeID int64

	NewName string

	NewNamespaceUserID int32
	NewNamespaceOrgID  int32
}

func (o MoveBatchChangeOpts) String() string {
	return fmt.Sprintf(
		"BatchChangeID %d, NewName %q, NewNamespaceUserID %d, NewNamespaceOrgID %d",
		o.BatchChangeID,
		o.NewName,
		o.NewNamespaceUserID,
		o.NewNamespaceOrgID,
	)
}

// MoveBatchChange moves the batch change from one namespace to another and/or renames
// the batch change.
func (s *Service) MoveBatchChange(ctx context.Context, opts MoveBatchChangeOpts) (batchChange *btypes.BatchChange, err error) {
	tr, ctx := trace.New(ctx, "Service.MoveBatchChange", opts.String())
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	tx, err := s.store.Transact(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { err = tx.Done(err) }()

	batchChange, err = tx.GetBatchChange(ctx, store.GetBatchChangeOpts{ID: opts.BatchChangeID})
	if err != nil {
		return nil, err
	}

	// 🚨 SECURITY: Only the Author of the batch change can move it.
	if err := backend.CheckSiteAdminOrSameUser(ctx, s.store.DB(), batchChange.InitialApplierID); err != nil {
		return nil, err
	}
	// Check if current user has access to target namespace if set.
	if opts.NewNamespaceOrgID != 0 || opts.NewNamespaceUserID != 0 {
		err = s.CheckNamespaceAccess(ctx, opts.NewNamespaceUserID, opts.NewNamespaceOrgID)
		if err != nil {
			return nil, err
		}
	}

	if opts.NewNamespaceOrgID != 0 {
		batchChange.NamespaceOrgID = opts.NewNamespaceOrgID
		batchChange.NamespaceUserID = 0
	} else if opts.NewNamespaceUserID != 0 {
		batchChange.NamespaceUserID = opts.NewNamespaceUserID
		batchChange.NamespaceOrgID = 0
	}

	if opts.NewName != "" {
		batchChange.Name = opts.NewName
	}

	return batchChange, tx.UpdateBatchChange(ctx, batchChange)
}

// CloseBatchChange closes the BatchChange with the given ID if it has not been closed yet.
func (s *Service) CloseBatchChange(ctx context.Context, id int64, closeChangesets bool) (batchChange *btypes.BatchChange, err error) {
	traceTitle := fmt.Sprintf("batchChange: %d, closeChangesets: %t", id, closeChangesets)
	tr, ctx := trace.New(ctx, "service.CloseBatchChange", traceTitle)
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	batchChange, err = s.store.GetBatchChange(ctx, store.GetBatchChangeOpts{ID: id})
	if err != nil {
		return nil, errors.Wrap(err, "getting batch change")
	}

	if batchChange.Closed() {
		return batchChange, nil
	}

	if err := backend.CheckSiteAdminOrSameUser(ctx, s.store.DB(), batchChange.InitialApplierID); err != nil {
		return nil, err
	}

	tx, err := s.store.Transact(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { err = tx.Done(err) }()

	batchChange.ClosedAt = s.clock()
	if err := tx.UpdateBatchChange(ctx, batchChange); err != nil {
		return nil, err
	}

	if !closeChangesets {
		return batchChange, nil
	}

	// At this point we don't know which changesets have ExternalStateOpen,
	// since some might still be being processed in the background by the
	// reconciler.
	// So enqueue all, except the ones that are completed and closed/merged,
	// for closing. If after being processed they're not open, it'll be a noop.
	if err := tx.EnqueueChangesetsToClose(ctx, batchChange.ID); err != nil {
		return nil, err
	}

	return batchChange, nil
}

// DeleteBatchChange deletes the BatchChange with the given ID if it hasn't been
// deleted yet.
func (s *Service) DeleteBatchChange(ctx context.Context, id int64) (err error) {
	traceTitle := fmt.Sprintf("BatchChange: %d", id)
	tr, ctx := trace.New(ctx, "service.BatchChange", traceTitle)
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	batchChange, err := s.store.GetBatchChange(ctx, store.GetBatchChangeOpts{ID: id})
	if err != nil {
		return err
	}

	if err := backend.CheckSiteAdminOrSameUser(ctx, s.store.DB(), batchChange.InitialApplierID); err != nil {
		return err
	}

	return s.store.DeleteBatchChange(ctx, id)
}

// EnqueueChangesetSync loads the given changeset from the database, checks
// whether the actor in the context has permission to enqueue a sync and then
// enqueues a sync by calling the repoupdater client.
func (s *Service) EnqueueChangesetSync(ctx context.Context, id int64) (err error) {
	traceTitle := fmt.Sprintf("changeset: %d", id)
	tr, ctx := trace.New(ctx, "service.EnqueueChangesetSync", traceTitle)
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	// Check for existence of changeset so we don't swallow that error.
	changeset, err := s.store.GetChangeset(ctx, store.GetChangesetOpts{ID: id})
	if err != nil {
		return err
	}

	// 🚨 SECURITY: We use database.Repos.Get to check whether the user has access to
	// the repository or not.
	if _, err = s.store.Repos().Get(ctx, changeset.RepoID); err != nil {
		return err
	}

	batchChanges, _, err := s.store.ListBatchChanges(ctx, store.ListBatchChangesOpts{ChangesetID: id})
	if err != nil {
		return err
	}

	// Check whether the user has admin rights for one of the batches.
	var (
		authErr        error
		hasAdminRights bool
	)

	for _, c := range batchChanges {
		err := backend.CheckSiteAdminOrSameUser(ctx, s.store.DB(), c.InitialApplierID)
		if err != nil {
			authErr = err
		} else {
			hasAdminRights = true
			break
		}
	}

	if !hasAdminRights {
		return authErr
	}

	if err := repoupdater.DefaultClient.EnqueueChangesetSync(ctx, []int64{id}); err != nil {
		return err
	}

	return nil
}

// ReenqueueChangeset loads the given changeset from the database, checks
// whether the actor in the context has permission to enqueue a reconciler run and then
// enqueues it by calling ResetReconcilerState.
func (s *Service) ReenqueueChangeset(ctx context.Context, id int64) (changeset *btypes.Changeset, repo *types.Repo, err error) {
	traceTitle := fmt.Sprintf("changeset: %d", id)
	tr, ctx := trace.New(ctx, "service.RenqueueChangeset", traceTitle)
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	changeset, err = s.store.GetChangeset(ctx, store.GetChangesetOpts{ID: id})
	if err != nil {
		return nil, nil, err
	}

	// 🚨 SECURITY: We use database.Repos.Get to check whether the user has access to
	// the repository or not.
	repo, err = s.store.Repos().Get(ctx, changeset.RepoID)
	if err != nil {
		return nil, nil, err
	}

	attachedBatchChanges, _, err := s.store.ListBatchChanges(ctx, store.ListBatchChangesOpts{ChangesetID: id})
	if err != nil {
		return nil, nil, err
	}

	// Check whether the user has admin rights for one of the batches.
	var (
		authErr        error
		hasAdminRights bool
	)

	for _, c := range attachedBatchChanges {
		err := backend.CheckSiteAdminOrSameUser(ctx, s.store.DB(), c.InitialApplierID)
		if err != nil {
			authErr = err
		} else {
			hasAdminRights = true
			break
		}
	}

	if !hasAdminRights {
		return nil, nil, authErr
	}

	if err := s.store.EnqueueChangeset(ctx, changeset, global.DefaultReconcilerEnqueueState(), btypes.ReconcilerStateFailed); err != nil {
		return nil, nil, err
	}

	return changeset, repo, nil
}

// CheckNamespaceAccess checks whether the current user in the ctx has access
// to either the user ID or the org ID as a namespace.
// If the userID is non-zero that will be checked. Otherwise the org ID will be
// checked.
// If the current user is an admin, true will be returned.
// Otherwise it checks whether the current user _is_ the namespace user or has
// access to the namespace org.
// If both values are zero, an error is returned.
func (s *Service) CheckNamespaceAccess(ctx context.Context, namespaceUserID, namespaceOrgID int32) error {
	if namespaceOrgID != 0 {
		return backend.CheckOrgAccessOrSiteAdmin(ctx, s.store.DB(), namespaceOrgID)
	} else if namespaceUserID != 0 {
		return backend.CheckSiteAdminOrSameUser(ctx, s.store.DB(), namespaceUserID)
	} else {
		return ErrNoNamespace
	}
}

// ErrNoNamespace is returned by checkNamespaceAccess if no valid namespace ID is given.
var ErrNoNamespace = errors.New("no namespace given")

// FetchUsernameForBitbucketServerToken fetches the username associated with a
// Bitbucket server token.
//
// We need the username in order to use the token as the password in a HTTP
// BasicAuth username/password pair used by gitserver to push commits.
//
// In order to not require from users to type in their BitbucketServer username
// we only ask for a token and then use that token to talk to the
// BitbucketServer API and get their username.
//
// Since Bitbucket sends the username as a header in REST responses, we can
// take it from there and complete the UserCredential.
func (s *Service) FetchUsernameForBitbucketServerToken(ctx context.Context, externalServiceID, externalServiceType, token string) (string, error) {
	css, err := s.sourcer.ForExternalService(ctx, s.store, store.GetExternalServiceIDsOpts{
		ExternalServiceType: externalServiceType,
		ExternalServiceID:   externalServiceID,
	})
	if err != nil {
		return "", err
	}
	css, err = css.WithAuthenticator(&auth.OAuthBearerToken{Token: token})
	if err != nil {
		return "", err
	}

	usernameSource, ok := css.(usernameSource)
	if !ok {
		return "", errors.New("external service source doesn't implement AuthenticatedUsername")
	}

	return usernameSource.AuthenticatedUsername(ctx)
}

// A usernameSource can fetch the username associated with the credentials used
// by the Source.
// It's only used by FetchUsernameForBitbucketServerToken.
type usernameSource interface {
	// AuthenticatedUsername makes a request to the code host to fetch the
	// username associated with the credentials.
	// If no username could be determined an error is returned.
	AuthenticatedUsername(ctx context.Context) (string, error)
}

var _ usernameSource = &sources.BitbucketServerSource{}

// ValidateAuthenticator creates a ChangesetSource, configures it with the given
// authenticator and validates it can correctly access the remote server.
func (s *Service) ValidateAuthenticator(ctx context.Context, externalServiceID, externalServiceType string, a auth.Authenticator) error {
	if Mocks.ValidateAuthenticator != nil {
		return Mocks.ValidateAuthenticator(ctx, externalServiceID, externalServiceType, a)
	}

	css, err := s.sourcer.ForExternalService(ctx, s.store, store.GetExternalServiceIDsOpts{
		ExternalServiceType: externalServiceType,
		ExternalServiceID:   externalServiceID,
	})
	if err != nil {
		return err
	}
	css, err = css.WithAuthenticator(a)
	if err != nil {
		return err
	}

	if err := css.ValidateAuthenticator(ctx); err != nil {
		return err
	}
	return nil
}

// ErrChangesetsForJobNotFound can be returned by (*Service).CreateChangesetJobs
// if the number of changesets returned from the database doesn't match the
// number if IDs passed in. That can happen if some of the changesets are not
// published.
var ErrChangesetsForJobNotFound = errors.New("some changesets could not be found")

// CreateChangesetJobs creates one changeset job for each given Changeset in the
// given BatchChange, checking whether the actor in the context has permission to
// trigger a job, and enqueues it.
func (s *Service) CreateChangesetJobs(ctx context.Context, batchChangeID int64, ids []int64, jobType btypes.ChangesetJobType, payload interface{}, listOpts store.ListChangesetsOpts) (bulkGroupID string, err error) {
	traceTitle := fmt.Sprintf("batchChangeID: %d, len(changesets): %d", batchChangeID, len(ids))
	tr, ctx := trace.New(ctx, "service.CreateChangesetJobs", traceTitle)
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	// Load the BatchChange to check for write permissions.
	batchChange, err := s.store.GetBatchChange(ctx, store.GetBatchChangeOpts{ID: batchChangeID})
	if err != nil {
		return bulkGroupID, errors.Wrap(err, "loading batch change")
	}

	// 🚨 SECURITY: Only the author of the batch change can create jobs.
	if err := backend.CheckSiteAdminOrSameUser(ctx, s.store.DB(), batchChange.InitialApplierID); err != nil {
		return bulkGroupID, err
	}

	// Construct list options.
	opts := listOpts
	opts.IDs = ids
	opts.BatchChangeID = batchChangeID
	// We only want to allow changesets the user has access to.
	opts.EnforceAuthz = true
	cs, _, err := s.store.ListChangesets(ctx, opts)
	if err != nil {
		return bulkGroupID, errors.Wrap(err, "listing changesets")
	}

	if len(cs) != len(ids) {
		return bulkGroupID, ErrChangesetsForJobNotFound
	}

	bulkGroupID, err = store.RandomID()
	if err != nil {
		return bulkGroupID, errors.Wrap(err, "creating bulkGroupID failed")
	}

	tx, err := s.store.Transact(ctx)
	if err != nil {
		return bulkGroupID, errors.Wrap(err, "starting transaction")
	}
	defer func() { err = tx.Done(err) }()

	userID := actor.FromContext(ctx).UID
	changesetJobs := make([]*btypes.ChangesetJob, 0, len(cs))
	for _, changeset := range cs {
		changesetJobs = append(changesetJobs, &btypes.ChangesetJob{
			BulkGroup:     bulkGroupID,
			ChangesetID:   changeset.ID,
			BatchChangeID: batchChangeID,
			UserID:        userID,
			State:         btypes.ChangesetJobStateQueued,
			JobType:       jobType,
			Payload:       payload,
		})
	}

	// Bulk-insert all changeset jobs into the database.
	if err := tx.CreateChangesetJob(ctx, changesetJobs...); err != nil {
		return bulkGroupID, errors.Wrap(err, "creating changeset jobs")
	}

	return bulkGroupID, nil
}

// RepoRevision describes a repository on a branch at a fixed revision.
type RepoRevision struct {
	Repo        *types.Repo
	Branch      string
	Commit      api.CommitID
	FileMatches []string
}

func (r *RepoRevision) HasBranch() bool {
	return r.Branch != ""
}

type RepoWorkspace struct {
	*RepoRevision
	Path  string
	Steps []batcheslib.Step

	OnlyFetchWorkspace bool
}

type ResolveWorkspacesForBatchSpecOpts struct {
	AllowIgnored     bool
	AllowUnsupported bool
}

// ResolveWorkspacesForBatchSpec takes the given batchSpec, and calculates the
// RepoWorkspaces matching the `on` part of the spec. For more details on this
// process, see workspaceResolver.ResolveWorkspacesForBatchSpec.
func (s *Service) ResolveWorkspacesForBatchSpec(
	ctx context.Context,
	batchSpec *batcheslib.BatchSpec,
	opts ResolveWorkspacesForBatchSpecOpts,
) (
	workspaces []*RepoWorkspace,
	unsupported map[*types.Repo]struct{},
	ignored map[*types.Repo]struct{},
	err error,
) {
	tr, ctx := trace.New(ctx, "service.ResolveWorkspacesForBatchSpec", "")
	defer func() {
		tr.SetError(err)
		tr.Finish()
	}()

	wr := &workspaceResolver{store: s.store, frontendInternalURL: api.InternalClient.URL + "/.internal"}
	return wr.ResolveWorkspacesForBatchSpec(ctx, batchSpec, opts)
}
