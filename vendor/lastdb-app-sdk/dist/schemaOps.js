/**
 * Node compatibility handshake, owner identity, and schema catalog operations.
 */
import { LASTDB_API_ROUTES, schemaRoute, scopedApiPath, } from './databases.js';
import { mapDataError, NodeTooOldError, UnexpectedResponseError } from './errors.js';
import { isHex64, isObject, sendJsonObject } from './responseParsers.js';
function stringOrNull(value) {
    return typeof value === 'string' ? value : null;
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((field) => typeof field === 'string')
        : [];
}
/** Parse a `GET /api/version` 200 body. */
function parseNodeVersion(body) {
    const b = isObject(body) ? body : {};
    const apiVersion = b['api_version'];
    if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 0) {
        throw new UnexpectedResponseError('version returned no api_version', 200, body);
    }
    const capabilities = {};
    if (isObject(b['capabilities'])) {
        for (const [k, v] of Object.entries(b['capabilities'])) {
            if (typeof v === 'boolean')
                capabilities[k] = v;
        }
    }
    const minApi = b['min_supported_api_version'];
    const build = b['build'];
    const instanceId = b['instance_id'];
    return {
        apiVersion,
        build: typeof build === 'string' && build.length > 0 ? build : null,
        capabilities,
        instanceId: typeof instanceId === 'string' && instanceId.length > 0 ? instanceId : null,
        minSupportedApiVersion: typeof minApi === 'number' && Number.isInteger(minApi) && minApi >= 0 ? minApi : null,
    };
}
/** Parse `GET /api/system/auto-identity` success JSON. */
function parseAutoIdentityResponse(body) {
    const b = isObject(body) ? body : {};
    const userHash = b['user_hash'];
    if (typeof userHash !== 'string' || userHash.length === 0) {
        throw new UnexpectedResponseError('auto-identity returned a provisioned body without user_hash', 200, body);
    }
    return {
        provisioned: true,
        userHash,
        publicKey: stringOrNull(b['public_key']),
        userId: stringOrNull(b['user_id']),
    };
}
function parseLoadedSchema(schema) {
    const name = stringOrNull(schema['name']) ?? '';
    const identityHash = stringOrNull(schema['identity_hash']) ?? name;
    return {
        name,
        identityHash,
        descriptiveName: stringOrNull(schema['descriptive_name']),
        ownerAppId: stringOrNull(schema['owner_app_id']),
        fields: stringArray(schema['fields']),
    };
}
function parseSchemaListResponse(body) {
    const b = isObject(body) ? body : {};
    const rawSchemas = Array.isArray(b['schemas']) ? b['schemas'] : [];
    return rawSchemas.filter(isObject).map(parseLoadedSchema);
}
function parseGetSchemaResponse(body) {
    if (!isObject(body) || !isObject(body['schema'])) {
        throw new UnexpectedResponseError('schema lookup returned no schema object', 200, body);
    }
    return parseLoadedSchema(body['schema']);
}
function sameFieldSet(actual, expected) {
    if (actual.length !== expected.length)
        return false;
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expected].sort();
    return actualSorted.every((field, i) => field === expectedSorted[i]);
}
function resolveLoadedSchema(schemas, descriptor) {
    const matches = schemas.filter((schema) => {
        if (schema.ownerAppId !== descriptor.ownerAppId)
            return false;
        if (schema.descriptiveName !== descriptor.descriptiveName)
            return false;
        return descriptor.fields === undefined || sameFieldSet(schema.fields, descriptor.fields);
    });
    if (matches.length === 0)
        return null;
    if (matches.length > 1) {
        throw new UnexpectedResponseError(`schema descriptor matched ${matches.length} loaded schemas`, 200, matches);
    }
    return matches[0] ?? null;
}
/** Record a declared schema's 64-hex `definition_id` for subsequent mutations. */
export function rememberSchemaDefinition(definitionIds, schemaName, definitionId) {
    if (!isHex64(definitionId)) {
        throw new UnexpectedResponseError('definition id must be a lowercase SHA-256', 0, definitionId);
    }
    definitionIds.set(schemaName, definitionId);
}
/** `GET /api/version` — client↔node compatibility handshake. */
export async function executeVersion(ctx) {
    const body = await sendJsonObject(ctx.transport, 'GET', LASTDB_API_ROUTES.version, 'version', ctx.appId);
    return parseNodeVersion(body);
}
/** Verify that the connected node reports `api_version >= required`. */
export async function executeRequireApiVersion(ctx, required, appLabel) {
    const node = await executeVersion(ctx);
    if (node.apiVersion < required) {
        throw new NodeTooOldError({
            reason: 'api_version_below_required',
            required,
            reported: node.apiVersion,
            build: node.build,
            app: appLabel ?? ctx.appId,
        });
    }
    return node;
}
/** `GET /api/system/auto-identity` — resolve the local owner identity. */
export async function executeAutoIdentity(ctx) {
    const res = await ctx.transport.send('GET', LASTDB_API_ROUTES.autoIdentity);
    if (res.status === 200) {
        return parseAutoIdentityResponse(res.body);
    }
    if (res.status === 503) {
        const body = isObject(res.body) ? res.body : {};
        return {
            provisioned: false,
            reason: typeof body['error'] === 'string' ? body['error'] : 'node_not_provisioned',
            next: typeof body['next'] === 'string' ? body['next'] : null,
        };
    }
    throw mapDataError('auto-identity', res.status, res.body, ctx.appId);
}
/** `POST /api/schemas/declare` (or database-scoped equivalent). */
export async function executeDeclareSchema(ctx, request) {
    const path = scopedApiPath(ctx.databasePath, LASTDB_API_ROUTES.schemasDeclare);
    const body = await sendJsonObject(ctx.transport, 'POST', path, 'declare schema', ctx.appId, {
        body: request,
    });
    const definitionId = body['definition_id'];
    const schemaName = body['schema'];
    if (typeof definitionId !== 'string' ||
        typeof schemaName !== 'string' ||
        schemaName.length === 0) {
        throw new UnexpectedResponseError('declare returned no definition id', 200, body);
    }
    rememberSchemaDefinition(ctx.definitionIds, schemaName, definitionId);
    const identity = body['identity_hash'];
    const resolution = body['resolution'];
    return {
        schemaName,
        definitionId,
        identityHash: typeof identity === 'string' ? identity : null,
        resolution: typeof resolution === 'string' ? resolution : null,
    };
}
/** `GET /api/schemas` (or database-scoped equivalent). */
export async function executeListSchemas(ctx) {
    const path = scopedApiPath(ctx.databasePath, LASTDB_API_ROUTES.schemas);
    const body = await sendJsonObject(ctx.transport, 'GET', path, 'schemas list', ctx.appId);
    return parseSchemaListResponse(body);
}
/** `GET /api/schema/<encoded>` (or database-scoped equivalent). Returns `null` on `404`. */
export async function executeGetSchema(ctx, schemaName) {
    const path = schemaRoute(ctx.databasePath, schemaName);
    const res = await ctx.transport.send('GET', path);
    if (res.status === 200) {
        return parseGetSchemaResponse(res.body);
    }
    if (res.status === 404) {
        return null;
    }
    throw mapDataError('get schema', res.status, res.body, ctx.appId);
}
/** Resolve an app-owned schema descriptor against `listSchemas()`. */
export async function executeResolveSchema(ctx, descriptor) {
    return resolveLoadedSchema(await executeListSchemas(ctx), descriptor);
}
//# sourceMappingURL=schemaOps.js.map