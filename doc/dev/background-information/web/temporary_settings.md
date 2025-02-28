# Temporary settings

Basic user settings that should be retained for users across sessions
can be stored as temporary settings. These should be trivial settings
that would be fine if they were lost.

For authenticated users, temporary settings are stored in the database 
in the `temporary_setings` table and are queried and modified via the GraphQL API.

For unauthenticated users, temporary settings are stored in `localStorage`. 

## Difference between temporary settings and site settings

Site settings are the primary way to handle settings in Sourcegraph. They are accessible as
global site settings, org settings, and user settings. These are the primary differences
between temporary settings and site settings:

|  | Site settings | Temporary settings |
|---|---|---|
| User editable | ✅  | ❌ |
| Cascades from global to org to users | ✅  | ❌ |
| Persisted across sessions | ✅  | ✅ |
| Stored for unauthenticated users | ❌ <br /> (will use global site settings) | ✅ |
| Typed schema | ✅  <br /> (in [`settings.schema.json`](https://sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/schema/settings.schema.json))| ✅  <br /> (in [`TemporarySettings.ts`](https://sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/client/web/src/settings/temporary/TemporarySettings.ts))|
| Available in Go code | ✅  | ❌ |


## Examples

Examples of data that is a good candidate for temporary settings include:

* Settings that should be available to unauthenticated users
* The dismiss state of a modal
* The collapse state of a panel
* Basic theme settings like "light" or "dark"
* "Most recently used" lists
* Data needed for keeping track of a user's interactions as part of an 
  A/B test or flight, or similar settings that should not be user-editable

Examples of data that should not be stored as temporary settings include:

* Any data that should not be retained between sessions, such as search results
* Any data that may need to be shared between users, such as a code insights chart
  or a search context configuration
* Data that may not be easily recoverable in a few clicks, such as a search notebook
* Settings that need to cascade from global site settings or org settings to users
  (temporary settings don't support cascading)
* Any settings the user would like to edit manually (temporary settings are not user-editable)

## Using temporary settings

### Update schema

Update the interface [`TemporarySettingsSchema` in `TemporarySettings.ts`](https://sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/client/web/src/settings/temporary/TemporarySettings.ts?L8:18) 
by adding a key for the setting you want to store. The key should be namespaced based on
the area of the site that will be using the settings. Example names include `'search.collapsedSidebarSections'` 
or `'codeInsights.hiddenCharts'`. The value of the setting can be any JSON-serializable type.

### Getting and setting settings

Use the React hook [`useTemporarySetting`](https://sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/client/web/src/settings/temporary/useTemporarySetting.ts?L14:33) 
to get an up-to-date value of the setting and a function that can update the value,
similar to other hooks like `useState`. The value will be updated automatically if
the user's authentication state changes or the setting is modified elsewhere in the
application.

#### Example usage:

```typescript
const [modalVisible, setModalVisible] = useTemporarySetting('example.modalVisible')

const toggleModal = () => {
    setModalVisible(currentVisibility => !currentVisibility)
}

return <>
    {modalVisible && <Modal onClose={toggleModal} />}
</>
```

### 🚨 Data sync warning

Currently, settings are not kept up-to-date if modified in more than one tab/browser at once,
which can cause settings to be out of sync and lost. **Do not use temporary settings for
important data that may not be easily recoverable with a few clicks.**
We will address this in the future.
