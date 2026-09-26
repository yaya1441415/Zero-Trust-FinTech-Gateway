import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SecretsProvider } from '@aws-lambda-powertools/parameters/secrets';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SSMProvider } from '@aws-lambda-powertools/parameters/ssm';
import { KmsKeyringNode, buildClient, CommitmentPolicy } from '@aws-crypto/client-node';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';


const client = new DynamoDBClient({})
const doClient = DynamoDBDocumentClient.from(client)

const secretsClient = new SecretsManagerClient({
    requestHandler: {connectionTimeout: 1000, requestTimeout: 2000},
    maxAttempts: 1,
})

//CACHE LiVES HERE 
const secretProvider = new SecretsProvider({awsSdkV3Client: secretsClient})

const ssmClient = new SSMClient({
    requestHandler: {connectionTimeout: 1000, requestTimeout: 2000 },
    maxAttempts: 1,
});
const ssmProvider  = new SSMProvider({awsSdkV3Client: ssmClient})

// Strictest setting: every message uses key commitment
const { encrypt, decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

// the keyring says which KMS key to use. Only this key can encrypt or decrypt.
const keyring = new KmsKeyringNode({ generatorKeyId: process.env.KMS_KEY_ARN! });

export const handler = async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
    const claims = event.requestContext.authorizer?.jwt?.claims;
    const sub = claims?.sub;

    if (typeof sub !== 'string' || !sub) {
        return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) };
    }

    //Interent Test 
    let internetReachable = false
    try{
        await fetch('https://example.com', {signal: AbortSignal.timeout(2000)});
        internetReachable = true
    } catch(error){
        internetReachable =  false
    }

    //DynamoDB write
    let dbWriteSuccess = false;
    try {
        await doClient.send(new PutCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
                pk: `USER#${sub}`,
                lastSeen: new Date().toISOString(),
            },
        }));
        dbWriteSuccess = true;

        
    }catch(error: any) {
        console.error('DynamoDB write failed', error);
    }

    // Secret Manager 
    let secretLoaded = false
    let secretFetchMs = 0;
    try{
        const start = Date.now();
        const secret = await secretProvider.get(process.env.SECRET_ARN!, {
            maxAge: 300,
            transform: 'json',
        })
        secretFetchMs = Date.now() - start;
        secretLoaded = true;
    }catch(error) {
        console.error('Secrets Manager fetch failed', error);
    }
    
    let maxTransferAmount: string | undefined;
    try{
        maxTransferAmount = await ssmProvider.get(process.env.PARAM_NAME!, { maxAge: 300 });

    }catch(error){
        console.error('SSM parameter fetch failed', error);
    }

    let accountMasked: string | undefined
    try{
        const pk = `USER#${sub}`;
        const context = { purpose: 'account-number', pk };

        const {result} = await encrypt(keyring, '123456789', { encryptionContext: context });

        // Store the ciphertext as base64 text
        await doClient.send(new PutCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
                pk,
                lastSeen: new Date().toISOString(),
                accountNumberEnc: result.toString('base64'),
            },
        }))

        const res = await doClient.send(new GetCommand({
            TableName: process.env.TABLE_NAME,
            Key: { pk },
        }));

        const {plaintext, messageHeader} = await decrypt(
            keyring,
            Buffer.from(res.Item!.accountNumberEnc, 'base64'),
        )

        if (messageHeader.encryptionContext.pk !== pk) {
            throw new Error('Encryption context mismatch');
        }

        const acct = plaintext.toString('utf8');
        accountMasked = '*'.repeat(acct.length - 4) + acct.slice(-4);
        
    }catch(error){
        console.error('Encryption test failed', error);
    }

    return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
            sub,
            internetReachable,
            dbWriteSuccess,
            secretLoaded, // Only return the boolean
            secretFetchMs,
            maxTransferAmount,
            accountMasked,
        }),
    };
}