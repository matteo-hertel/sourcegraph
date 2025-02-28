import { storiesOf } from '@storybook/react'
import * as H from 'history'
import React from 'react'
import { of } from 'rxjs'

import { Location } from '@sourcegraph/extension-api-types'
import { NOOP_TELEMETRY_SERVICE } from '@sourcegraph/shared/src/telemetry/telemetryService'
import { extensionsController } from '@sourcegraph/shared/src/util/searchTestHelpers'
import webStyles from '@sourcegraph/web/src/SourcegraphWebApp.scss'

import { BrandedStory } from '../../BrandedStory'

import { HierarchicalLocationsView, HierarchicalLocationsViewProps } from './HierarchicalLocationsView'

const { add } = storiesOf('branded/HierarchicalLocationsView', module).addDecorator(story => (
    <BrandedStory styles={webStyles}>{() => <div className="p-5">{story()}</div>}</BrandedStory>
))

const LOCATIONS: Location[] = [
    {
        uri: 'git://github.com/foo/bar#file1.txt',
        range: {
            start: {
                line: 1,
                character: 0,
            },
            end: {
                line: 1,
                character: 10,
            },
        },
    },
    {
        uri: 'git://github.com/foo/bar#file2.txt',
        range: {
            start: {
                line: 2,
                character: 0,
            },
            end: {
                line: 2,
                character: 10,
            },
        },
    },
    {
        uri: 'git://github.com/baz/qux#file3.txt',
        range: {
            start: {
                line: 3,
                character: 0,
            },
            end: {
                line: 3,
                character: 10,
            },
        },
    },
    {
        uri: 'git://github.com/baz/qux#file4.txt',
        range: {
            start: {
                line: 4,
                character: 0,
            },
            end: {
                line: 4,
                character: 10,
            },
        },
    },
    {
        uri: 'git://github.com/baz/qux#file4.txt',
        range: {
            start: {
                line: 5,
                character: 0,
            },
            end: {
                line: 5,
                character: 10,
            },
        },
    },
]

const PROPS: HierarchicalLocationsViewProps = {
    extensionsController,
    settingsCascade: { subjects: null, final: null },
    location: H.createLocation('/'),
    locations: of({ isLoading: false, result: LOCATIONS }),
    defaultGroup: 'git://github.com/foo/bar',
    isLightTheme: true,
    fetchHighlightedFileLineRanges: () => of([['line1\n', 'line2\n', 'line3\n', 'line4']]),
    versionContext: undefined,
    telemetryService: NOOP_TELEMETRY_SERVICE,
}

add('Single repo', () => (
    <HierarchicalLocationsView
        {...PROPS}
        locations={of({ isLoading: false, result: LOCATIONS.filter(({ uri }) => uri.includes('github.com/foo/bar')) })}
    />
))

add('Grouped by repo', () => <HierarchicalLocationsView {...PROPS} />)

add('Grouped by repo and file', () => (
    <HierarchicalLocationsView
        {...PROPS}
        settingsCascade={{
            subjects: null,
            final: {
                'panel.locations.groupByFile': true,
            },
        }}
    />
))
