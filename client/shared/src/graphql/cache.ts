import { InMemoryCache } from '@apollo/client'

import { TypedTypePolicies } from '../graphql-operations'

// Defines how the Apollo cache interacts with our GraphQL schema.
// See https://www.apollographql.com/docs/react/caching/cache-configuration/#typepolicy-fields
const typePolicies: TypedTypePolicies = {
    Query: {
        fields: {
            node: {
                // Node is a top-level interface field used to easily fetch from different parts of the schema through the relevant `id`.
                // We always want to merge responses from this field as it will be used through very different queries.
                merge: true,
            },
        },
    },
}

export const generateCache = (): InMemoryCache =>
    new InMemoryCache({
        typePolicies,
    })

export const cache = generateCache()
