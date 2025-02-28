import assert from 'assert'

import { ExtensionsResult } from '@sourcegraph/shared/src/graphql-operations'
import { createDriverForTest, Driver } from '@sourcegraph/shared/src/testing/driver'
import { afterEachSaveScreenshotIfFailed } from '@sourcegraph/shared/src/testing/screenshotReporter'

import { RegistryExtensionFieldsForList } from '../graphql-operations'

import { createWebIntegrationTestContext, WebIntegrationTestContext } from './context'
import { commonWebGraphQlResults } from './graphQlResults'
import { siteGQLID, siteID } from './jscontext'
import { percySnapshotWithVariants } from './utils'

const typescriptRawManifest = JSON.stringify({
    activationEvents: ['*'],
    browserslist: [],
    categories: ['Programming languages'],
    contributes: {},
    description: 'TypeScript/JavaScript code intelligence',
    devDependencies: {},
    extensionID: 'sourcegraph/typescript',
    main: 'dist/extension.js',
    name: 'typescript',
    publisher: 'sourcegraph',
    readme: '# Code intelligence for TypeScript/JavaScript',
    scripts: {},
    tags: [],
    url:
        'https://sourcegraph.com/-/static/extension/7895-sourcegraph-typescript.js?c4ri18f15tv4--sourcegraph-typescript',
    version: '0.0.0-DEVELOPMENT',
})

const wordCountBundleUrl = 'https://sourcegraph.com/-/static/extension/sqs-word-count.js'

const wordCountRawManifest = JSON.stringify({
    activationEvents: ['*'],
    browserslist: [],
    contributes: {},
    description: 'Counts the number of words in a file',
    devDependencies: {},
    extensionID: 'sqs/word-count',
    license: 'MIT',
    main: 'dist/word-count.js',
    name: 'word-count',
    publisher: 'sqs',
    readme: '# Word count (Sourcegraph extension))\n',
    scripts: {},
    title: 'Word count',
    url: wordCountBundleUrl,
    version: '0.0.0-DEVELOPMENT',
})

const registryExtensionNodes: RegistryExtensionFieldsForList[] = [
    {
        id: 'test-extension-1',
        publisher: null,
        extensionID: 'sourcegraph/typescript',
        extensionIDWithoutRegistry: 'sourcegraph/typescript',
        name: 'typescript',
        manifest: {
            raw: typescriptRawManifest,
            description: 'TypeScript/JavaScript code intelligence',
        },
        createdAt: '2019-01-26T03:39:17Z',
        updatedAt: '2019-01-26T03:39:17Z',
        url: '/extensions/sourcegraph/typescript',
        remoteURL: 'https://sourcegraph.com/extensions/sourcegraph/typescript',
        registryName: 'sourcegraph.com',
        isLocal: false,
        isWorkInProgress: false,
        viewerCanAdminister: false,
    },
    {
        id: 'test-extension-2',
        publisher: null,
        extensionID: 'sqs/word-count',
        extensionIDWithoutRegistry: 'sqs/word-count',
        name: 'word-count',
        manifest: {
            raw: wordCountRawManifest,
            description: 'Counts the number of words in a file',
        },
        createdAt: '2018-10-28T22:33:08Z',
        updatedAt: '2018-10-28T22:33:08Z',
        url: '/extensions/sqs/word-count',
        remoteURL: 'https://sourcegraph.com/extensions/sqs/word-count',
        registryName: 'sourcegraph.com',
        isLocal: false,
        isWorkInProgress: false,
        viewerCanAdminister: false,
    },
]

const extensionNodes: ExtensionsResult['extensionRegistry']['extensions']['nodes'] = [
    {
        extensionID: 'sourcegraph/typescript',
        manifest: {
            jsonFields: typescriptRawManifest,
        },
    },
    {
        extensionID: 'sqs/word-count',
        manifest: {
            jsonFields: wordCountRawManifest,
        },
    },
]

describe('Extension Registry', () => {
    let driver: Driver
    before(async () => {
        driver = await createDriverForTest()
    })
    after(() => driver?.close())
    let testContext: WebIntegrationTestContext
    beforeEach(async function () {
        testContext = await createWebIntegrationTestContext({
            driver,
            currentTest: this.currentTest!,
            directory: __dirname,
        })
    })
    afterEachSaveScreenshotIfFailed(() => driver.page)
    afterEach(() => testContext?.dispose())

    function overrideGraphQLExtensionRegistry({ enabled }: { enabled: boolean }): void {
        testContext.overrideGraphQL({
            ...commonWebGraphQlResults,
            ViewerSettings: () => ({
                viewerSettings: {
                    __typename: 'SettingsCascade',
                    subjects: [
                        {
                            __typename: 'DefaultSettings',
                            settingsURL: null,
                            viewerCanAdminister: false,
                            latestSettings: {
                                id: 0,
                                contents: JSON.stringify({}),
                            },
                        },
                        {
                            __typename: 'Site',
                            id: siteGQLID,
                            siteID,
                            latestSettings: {
                                id: 470,
                                contents: JSON.stringify({}),
                            },
                            settingsURL: '/site-admin/global-settings',
                            viewerCanAdminister: true,
                            allowSiteSettingsEdits: true,
                        },
                        {
                            __typename: 'User',
                            id: 'TestGQLUserID',
                            username: 'testusername',
                            settingsURL: '/user/testusername/settings',
                            displayName: 'test',
                            viewerCanAdminister: true,
                            latestSettings: {
                                id: 310,
                                contents: JSON.stringify({ extensions: { 'sqs/word-count': enabled } }),
                            },
                        },
                    ],
                    final: JSON.stringify({}),
                },
            }),
            CurrentAuthState: () => ({
                currentUser: {
                    __typename: 'User',
                    id: 'TestGQLUserID',
                    databaseID: 1,
                    username: 'testusername',
                    avatarURL: null,
                    email: 'test@test.com',
                    displayName: 'test',
                    siteAdmin: true,
                    tags: [],
                    url: '/users/test',
                    settingsURL: '/users/test/settings',
                    organizations: { nodes: [] },
                    session: { canSignOut: true },
                    viewerCanAdminister: true,
                },
            }),
            RegistryExtensions: () => ({
                extensionRegistry: {
                    __typename: 'ExtensionRegistry',
                    extensions: {
                        error: null,
                        nodes: registryExtensionNodes,
                    },
                    featuredExtensions: null,
                },
            }),
            Extensions: () => ({
                extensionRegistry: {
                    __typename: 'ExtensionRegistry',
                    extensions: {
                        nodes: extensionNodes,
                    },
                },
            }),
            EditSettings: () => ({
                configurationMutation: {
                    editConfiguration: {
                        empty: null,
                    },
                },
            }),
        })
        // Mock extension bundle
        testContext.server.get(wordCountBundleUrl).intercept((request, response) => {
            response.type('application/javascript; charset=utf-8').send('exports.activate = () => {}')
        })
    }

    it('is styled correctly', async () => {
        overrideGraphQLExtensionRegistry({ enabled: false })
        await driver.page.goto(driver.sourcegraphBaseUrl + '/extensions')

        //  wait for initial set of extensions
        await driver.page.waitForSelector('[data-test="extension-toggle-sqs/word-count"]')

        await percySnapshotWithVariants(driver.page, 'Extension registry page')
    })

    describe('filtering by category', () => {
        it('only shows extensions from the selected categories', async () => {
            overrideGraphQLExtensionRegistry({ enabled: false })
            await driver.page.goto(driver.sourcegraphBaseUrl + '/extensions')

            //  wait for initial set of extensions
            await driver.page.waitForSelector('[data-test="extension-toggle-sqs/word-count"]')
            assert(
                await driver.page.$('[data-test="extension-toggle-sqs/word-count"]'),
                'Expected non-language extensions to be displayed by default'
            )
            assert(
                !(await driver.page.$('[data-test="extension-toggle-sourcegraph/typescript"]')),
                'Expected language extensions to not be displayed by default'
            )
            // Toggle programming language extension category
            await driver.page.click('[data-test-extension-category="Programming languages"')
            // Wait for the category header to change
            await driver.page.waitForSelector('[data-test-extension-category-header="Programming languages"]')
            assert(
                !(await driver.page.$('[data-test="extension-toggle-sqs/word-count"]')),
                "Expected non-language extensions to not be displayed when only 'Programming languages' are toggled"
            )
            assert(
                await driver.page.$('[data-test="extension-toggle-sourcegraph/typescript"]'),
                "Expected language extensions to be displayed by when 'Programming languages' are toggled"
            )
        })
    })

    describe('searching', () => {
        it('input leads to the correct query', async () => {
            // testing that text input makes it through the RxJS pipeline
            overrideGraphQLExtensionRegistry({ enabled: false })
            await driver.page.goto(driver.sourcegraphBaseUrl + '/extensions')

            await driver.page.waitForSelector('.test-extension-registry-input')
            const request = await testContext.waitForGraphQLRequest(async () => {
                await driver.replaceText({
                    selector: '.test-extension-registry-input',
                    newText: 'sqs',
                    enterTextMethod: 'paste',
                })
            }, 'RegistryExtensions')

            assert.deepStrictEqual(request, {
                getFeatured: false,
                query: 'sqs',
                prioritizeExtensionIDs: [],
            })
        })
    })

    describe('toggling', () => {
        it('a disabled extension enables it', async () => {
            const enabled = false
            overrideGraphQLExtensionRegistry({ enabled })

            await driver.page.goto(driver.sourcegraphBaseUrl + '/extensions')

            // toggle typescript extension on
            const request = await testContext.waitForGraphQLRequest(async () => {
                await driver.page.waitForSelector("[data-test='extension-toggle-sqs/word-count']")
                await driver.page.click("[data-test='extension-toggle-sqs/word-count']")
            }, 'EditSettings')

            assert.deepStrictEqual(request, {
                subject: 'TestGQLUserID',
                lastID: 310,
                edit: {
                    keyPath: [{ property: 'extensions' }, { property: 'sqs/word-count' }],
                    value: !enabled,
                },
            })
        })

        it('an enabled extension disables it ', async () => {
            const enabled = true
            overrideGraphQLExtensionRegistry({ enabled })

            await driver.page.goto(driver.sourcegraphBaseUrl + '/extensions')

            // toggle typescript extension off
            const request = await testContext.waitForGraphQLRequest(async () => {
                await driver.page.waitForSelector("[data-test='extension-toggle-sqs/word-count']")
                await driver.page.click("[data-test='extension-toggle-sqs/word-count']")
            }, 'EditSettings')

            assert.deepStrictEqual(request, {
                subject: 'TestGQLUserID',
                lastID: 310,
                edit: {
                    keyPath: [{ property: 'extensions' }, { property: 'sqs/word-count' }],
                    value: !enabled,
                },
            })
        })
    })
})
