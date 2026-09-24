import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export const handler = async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
    // API Gateway has already  validated the JWT.
    // we jsut extract the claims

    const claims = event.requestContext.authorizer?.jwt?.claims;

    if (!claims || !claims.sub) {
        // Defensive: Should never happen if the authorizer is configured correctly
        return {
            statusCode: 401,
            body: JSON.stringify({ message: 'Unauthorized: Missing sub claim' }),
        }
    }
    
    return {
        statusCode: 200,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            message: 'Zero Trust Validation Successful',
            sub: claims.sub,
        })
    }
}