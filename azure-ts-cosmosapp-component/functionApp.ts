// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

import { CosmosClient } from "@azure/cosmos";
import * as azure from "@pulumi/azure";
import * as pulumi from "@pulumi/pulumi";
import { CosmosApp, GlobalContext, RegionalContext } from "./cosmosApp";

// Read a list of target locations from the config file:
// Expecting a comma-separated list, e.g., "westus,eastus,westeurope"
const locations = new pulumi.Config().require("locations").split(",");

const resourceGroup = new azure.core.ResourceGroup("cosmosfunc-rg", {
    location: locations[0],
});

function buildFunctionApp({ cosmosAccount, database, container, opts }: GlobalContext) {
    return ({ location }: RegionalContext) => {
        const fn = new azure.appservice.HttpEventSubscription(`GetUrl-${location}`, {
            resourceGroup,
            location,
            route: "{key}",
            callbackFactory: () => {
                const client = new CosmosClient({
                    endpoint: cosmosAccount.endpoint.get(),
                    key: cosmosAccount.primaryMasterKey.get(),
                    connectionPolicy: { preferredLocations: [location] },
                });
                const collection = client.database(database.name.get()).container(container.name.get());

                return async (_, request: azure.appservice.HttpRequest) => {
                    const key = request.params.key;
                    if (key === "ping") {
                        // Handle traffic manager live pings
                        return { status: 200, body: "Ping ACK" };
                    }

                    try {
                        const response = await collection.item(key, undefined).read();

                        return { status: 200, body: response.resource || `Document '${key}' not found` };
                    } catch (e) {
                        // Cosmos SDK throws an error for non-existing documents
                        return { status: 200, body: `Document '${key}' not found` };
                    }
                };
            },
        }, opts);

        return {
            id: fn.functionApp.id,
        };
    };
}

export const functions = new CosmosApp("functions", {
    resourceGroup,
    locations,
    databaseName: "productsdb",
    containerName: "products",
    factory: buildFunctionApp,
});

export function buildProductApp({ resourceGroup, cosmosAccount, opts }: GlobalContext) {
    return ({ location }: RegionalContext) => {
        const app = new azure.appservice.ArchiveFunctionApp("function-app", {
            resourceGroupName: resourceGroup.name,
            archive: new pulumi.asset.FileArchive("./app"),
            appSettings: {
                COSMOSDB_ENDPOINT: cosmosAccount.endpoint,
                COSMOSDB_KEY: cosmosAccount.primaryMasterKey,
                COSMOSDB_LOCATION: location,
            },
        }, opts);

        return {
            id: app.functionApp.id,
        };
    };
}
