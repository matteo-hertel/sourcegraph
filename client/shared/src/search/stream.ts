/* eslint-disable id-length */
import { Observable, fromEvent, Subscription, OperatorFunction, pipe, Subscriber, Notification } from 'rxjs'
import { defaultIfEmpty, map, materialize, scan } from 'rxjs/operators'
import { AggregableBadge } from 'sourcegraph'

import { asError, ErrorLike, isErrorLike } from '@sourcegraph/shared/src/util/errors'

import { displayRepoName } from '../components/RepoFileLink'
import { SearchPatternType } from '../graphql-operations'
import { SymbolKind } from '../graphql/schema'

export type SearchEvent =
    | { type: 'matches'; data: SearchMatch[] }
    | { type: 'progress'; data: Progress }
    | { type: 'filters'; data: Filter[] }
    | { type: 'alert'; data: Alert }
    | { type: 'error'; data: ErrorLike }
    | { type: 'done'; data: {} }

export type SearchMatch = ContentMatch | RepositoryMatch | CommitMatch | SymbolMatch | PathMatch

export interface PathMatch {
    type: 'path'
    path: string
    repository: string
    repoStars?: number
    repoLastFetched?: string
    branches?: string[]
    commit?: string
}

export interface ContentMatch {
    type: 'content'
    path: string
    repository: string
    repoStars?: number
    repoLastFetched?: string
    branches?: string[]
    commit?: string
    lineMatches: LineMatch[]
    hunks?: DecoratedHunk[]
}

export interface DecoratedHunk {
    content: DecoratedContent
    lineStart: number
    lineCount: number
    matches: Range[]
}

export interface DecoratedContent {
    plaintext?: string
    html?: string
}

export interface Range {
    start: Location
    end: Location
}

export interface Location {
    offset: number
    line: number
    column: number
}

interface LineMatch {
    line: string
    lineNumber: number
    offsetAndLengths: number[][]
    aggregableBadges?: AggregableBadge[]
}

export interface SymbolMatch {
    type: 'symbol'
    path: string
    repository: string
    repoStars?: number
    repoLastFetched?: string
    branches?: string[]
    commit?: string
    symbols: MatchedSymbol[]
}

interface MatchedSymbol {
    url: string
    name: string
    containerName: string
    kind: SymbolKind
}

type MarkdownText = string

/**
 * Our batch based client requests generic fields from GraphQL to represent repo and commit/diff matches.
 * We currently are only using it for commit. To simplify the PoC we are keeping this interface for commits.
 *
 * @see GQL.IGenericSearchResultInterface
 */
export interface CommitMatch {
    type: 'commit'
    label: MarkdownText
    url: string
    detail: MarkdownText
    repository: string
    repoStars?: number
    repoLastFetched?: string

    content: MarkdownText
    ranges: number[][]
}

export interface RepositoryMatch {
    type: 'repo'
    repository: string
    repoStars?: number
    repoLastFetched?: string
    description?: string
    fork?: boolean
    archived?: boolean
    private?: boolean
    branches?: string[]
}

/**
 * An aggregate type representing a progress update.
 * Should be replaced when a new ones come in.
 */
export interface Progress {
    /**
     * The number of repositories matching the repo: filter. Is set once they
     * are resolved.
     */
    repositoriesCount?: number

    // The number of non-overlapping matches. If skipped is non-empty, then
    // this is a lower bound.
    matchCount: number

    // Wall clock time in milliseconds for this search.
    durationMs: number

    /**
     * A description of shards or documents that were skipped. This has a
     * deterministic ordering. More important reasons will be listed first. If
     * a search is repeated, the final skipped list will be the same.
     * However, within a search stream when a new skipped reason is found, it
     * may appear anywhere in the list.
     */
    skipped: Skipped[]

    // The URL of the trace for this query, if it exists.
    trace?: string
}

export interface Skipped {
    /**
     * Why a document/shard/repository was skipped. We group counts by reason.
     *
     * - document-match-limit :: we found too many matches in a document, so we stopped searching it.
     * - shard-match-limit :: we found too many matches in a shard/repository, so we stopped searching it.
     * - repository-limit :: we did not search a repository because the set of repositories to search was too large.
     * - shard-timeout :: we ran out of time before searching a shard/repository.
     * - repository-cloning :: we could not search a repository because it is not cloned.
     * - repository-missing :: we could not search a repository because it is not cloned and we failed to find it on the remote code host.
     * - excluded-fork :: we did not search a repository because it is a fork.
     * - excluded-archive :: we did not search a repository because it is archived.
     * - display :: we hit the display limit, so we stopped sending results from the backend.
     */
    reason:
        | 'document-match-limit'
        | 'shard-match-limit'
        | 'repository-limit'
        | 'shard-timedout'
        | 'repository-cloning'
        | 'repository-missing'
        | 'excluded-fork'
        | 'excluded-archive'
        | 'display'
        | 'error'
    /**
     * A short message. eg 1,200 timed out.
     */
    title: string
    /**
     * A message to show the user. Usually includes information explaining the reason,
     * count as well as a sample of the missing items.
     */
    message: string
    severity: 'info' | 'warn' | 'error'
    /**
     * a suggested query expression to remedy the skip. eg "archived:yes" or "timeout:2m".
     */
    suggested?: {
        title: string
        queryExpression: string
    }
}

export interface Filter {
    value: string
    label: string
    count: number
    limitHit: boolean
    kind: string
}

interface Alert {
    title: string
    description?: string | null
    proposedQueries: ProposedQuery[] | null
}

interface ProposedQuery {
    description?: string | null
    query: string
}

export type StreamingResultsState = 'loading' | 'error' | 'complete'

interface BaseAggregateResults {
    state: StreamingResultsState
    results: SearchMatch[]
    alert?: Alert
    filters: Filter[]
    progress: Progress
}

interface SuccessfulAggregateResults extends BaseAggregateResults {
    state: 'loading' | 'complete'
}

interface ErrorAggregateResults extends BaseAggregateResults {
    state: 'error'
    error: Error
}

export type AggregateStreamingSearchResults = SuccessfulAggregateResults | ErrorAggregateResults

export const emptyAggregateResults: AggregateStreamingSearchResults = {
    state: 'loading',
    results: [],
    filters: [],
    progress: {
        durationMs: 0,
        matchCount: 0,
        skipped: [],
    },
}

/**
 * Converts a stream of SearchEvents into AggregateStreamingSearchResults
 */
const switchAggregateSearchResults: OperatorFunction<SearchEvent, AggregateStreamingSearchResults> = pipe(
    materialize(),
    scan(
        (
            results: AggregateStreamingSearchResults,
            newEvent: Notification<SearchEvent>
        ): AggregateStreamingSearchResults => {
            switch (newEvent.kind) {
                case 'N': {
                    switch (newEvent.value?.type) {
                        case 'matches':
                            return {
                                ...results,
                                // Matches are additive
                                results: results.results.concat(newEvent.value.data),
                            }

                        case 'progress':
                            return {
                                ...results,
                                // Progress updates replace
                                progress: newEvent.value.data,
                            }

                        case 'filters':
                            return {
                                ...results,
                                // New filter results replace all previous ones
                                filters: newEvent.value.data,
                            }

                        case 'alert':
                            return {
                                ...results,
                                alert: newEvent.value.data,
                            }

                        default:
                            return results
                    }
                }
                case 'E': {
                    // Add the error as an extra skipped item
                    const error = asError(newEvent.error)
                    const errorSkipped: Skipped = {
                        title: 'Error loading results',
                        message: error.message,
                        reason: 'error',
                        severity: 'error',
                    }
                    return {
                        ...results,
                        error,
                        progress: {
                            ...results.progress,
                            skipped: [errorSkipped, ...results.progress.skipped],
                        },
                        state: 'error',
                    }
                }
                case 'C':
                    return {
                        ...results,
                        state: 'complete',
                    }
                default:
                    return results
            }
        },
        emptyAggregateResults
    ),
    defaultIfEmpty(emptyAggregateResults as AggregateStreamingSearchResults)
)

const observeMessages = <T extends SearchEvent>(
    type: T['type'],
    eventSource: EventSource,
    observer: Subscriber<SearchEvent>
): Subscription =>
    fromEvent(eventSource, type)
        .pipe(
            map((event: Event) => {
                if (!(event instanceof MessageEvent)) {
                    throw new TypeError(`internal error: expected MessageEvent in streaming search ${type}`)
                }
                try {
                    const parsedData = JSON.parse(event.data) as T['data']
                    return parsedData
                } catch {
                    throw new Error(`Could not parse ${type} message data in streaming search`)
                }
            }),
            map(data => ({ type, data } as T))
        )
        .subscribe(observer)

type MessageHandler<EventType extends SearchEvent['type'] = SearchEvent['type']> = (
    type: EventType,
    eventSource: EventSource,
    observer: Subscriber<SearchEvent>
) => Subscription

const messageHandlers: {
    [EventType in SearchEvent['type']]: MessageHandler<EventType>
} = {
    done: (type, eventSource, observer) =>
        fromEvent(eventSource, type).subscribe(() => {
            observer.complete()
            eventSource.close()
        }),
    error: (type, eventSource, observer) =>
        fromEvent(eventSource, type).subscribe(event => {
            let error: ErrorLike | null = null
            if (event instanceof MessageEvent) {
                try {
                    error = JSON.parse(event.data) as ErrorLike
                } catch {
                    error = null
                }
            }

            if (isErrorLike(error)) {
                observer.error(error)
            } else {
                // The EventSource API can return a DOM event that is not an Error object
                // (e.g. doesn't have the message property), so we need to construct our own here.
                // See https://developer.mozilla.org/en-US/docs/Web/API/EventSource/error_event
                observer.error(
                    new Error(
                        'The connection was closed before your search was completed. This may be due to a problem with a firewall, VPN or proxy, or a failure with the Sourcegraph server.'
                    )
                )
            }
            eventSource.close()
        }),
    matches: observeMessages,
    progress: observeMessages,
    filters: observeMessages,
    alert: observeMessages,
}

export interface StreamSearchOptions {
    query: string
    version: string
    patternType: SearchPatternType
    caseSensitive: boolean
    versionContext: string | undefined
    trace: string | undefined
    decorationKinds?: string[]
    decorationContextLines?: number
}

/**
 * Initiates a streaming search. This is a type safe wrapper around Sourcegraph's streaming search API (using Server Sent Events).
 * The observable will emit each event returned from the backend.
 *
 * @param query the search query to send to Sourcegraph's backend.
 */
function search({
    query,
    version,
    patternType,
    caseSensitive,
    versionContext,
    trace,
    decorationKinds,
    decorationContextLines,
}: StreamSearchOptions): Observable<SearchEvent> {
    return new Observable<SearchEvent>(observer => {
        const parameters = [
            ['q', `${query} ${caseSensitive ? 'case:yes' : ''}`],
            ['v', version],
            ['t', patternType as string],
            ['dl', '0'],
            ['dk', (decorationKinds || ['html']).join('|')],
            ['dc', (decorationContextLines || '1').toString()],
            ['display', '1500'],
        ]
        if (versionContext) {
            parameters.push(['vc', versionContext])
        }
        if (trace) {
            parameters.push(['trace', trace])
        }
        const parameterEncoded = parameters.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&')

        const eventSource = new EventSource('/search/stream?' + parameterEncoded)
        const subscriptions = new Subscription()
        for (const [eventType, handleMessages] of Object.entries(messageHandlers)) {
            subscriptions.add(
                (handleMessages as MessageHandler)(eventType as SearchEvent['type'], eventSource, observer)
            )
        }
        return () => {
            subscriptions.unsubscribe()
            eventSource.close()
        }
    })
}

/** Initiate a streaming search and aggregate the results */
export function aggregateStreamingSearch(options: StreamSearchOptions): Observable<AggregateStreamingSearchResults> {
    return search(options).pipe(switchAggregateSearchResults)
}

export function getRepositoryUrl(repository: string, branches?: string[]): string {
    const branch = branches?.[0]
    const revision = branch ? `@${branch}` : ''
    const label = repository + revision
    return '/' + encodeURI(label)
}

export function getRevision(branches?: string[], version?: string): string {
    let revision = ''
    if (branches) {
        const branch = branches[0]
        if (branch !== '') {
            revision = branch
        }
    } else if (version) {
        revision = version
    }

    return revision
}

export function getFileMatchUrl(fileMatch: ContentMatch | SymbolMatch | PathMatch): string {
    const revision = getRevision(fileMatch.branches, fileMatch.commit)
    return `/${fileMatch.repository}${revision ? '@' + revision : ''}/-/blob/${fileMatch.path}`
}

export function getRepoMatchLabel(repoMatch: RepositoryMatch): string {
    const branch = repoMatch?.branches?.[0]
    const revision = branch ? `@${branch}` : ''
    return repoMatch.repository + revision
}

export function getRepoMatchUrl(repoMatch: RepositoryMatch): string {
    const label = getRepoMatchLabel(repoMatch)
    return '/' + encodeURI(label)
}

export function getMatchUrl(match: SearchMatch): string {
    switch (match.type) {
        case 'path':
        case 'content':
        case 'symbol':
            return getFileMatchUrl(match)
        case 'commit':
            return match.url
        case 'repo':
            return getRepoMatchUrl(match)
    }
}

export function getMatchTitle(match: RepositoryMatch | CommitMatch): MarkdownText {
    if (match.type === 'commit') {
        return match.label
    }

    return `[${displayRepoName(getRepoMatchLabel(match))}](${getRepoMatchUrl(match)})`
}
