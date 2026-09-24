import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

export class ZeroTrustFinTechGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


      const userPool = new cognito.UserPool(this, 'AppUserPool', {
        userPoolName: 'my-app-user-pool',
        selfSignUpEnabled: false,
        signInAliases: {
          email: true, // Users sign in with their email address
        },
        passwordPolicy: { 
          minLength: 12, 
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: true,
        },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy:cdk.RemovalPolicy.RETAIN,
      })

      //An app client with no client secret 
      // ad with the USER_PASSWORD_AUTH
      //flow enabled so you can test from the CLI.
      const userPoolClient = new cognito.UserPoolClient(this, 'AppUserPoolClient', {
        userPool: userPool,
        userPoolClientName: 'my-web-app-client',
        generateSecret: false,
        authFlows: {
          userPassword: true, // Enables USER_PASSWORD_AUTH
          userSrp: true, // Enables USER_SRP_AUTH (recommended default)
        },
        preventUserExistenceErrors: true,
        accessTokenValidity: cdk.Duration.minutes(15),
        idTokenValidity: cdk.Duration.minutes(15),
        refreshTokenValidity: cdk.Duration.days(1),

      })

      const meLambda = new NodejsFunction(this, 'MeLambda', {
        entry: path.join(__dirname, '..', 'lambda', 'me.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256, //
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: true,
        }
      })

      const api = new HttpApi(this, 'FinTechApi', {
        apiName: 'zero-trust-fintech-api',
        corsPreflight: {
          allowOrigins: ['https://your-frontend-domain.com'],
          allowMethods: [CorsHttpMethod.GET],
          allowHeaders: ['Authorization', 'Content-Type'],
        }
      })

      const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
        userPoolClients: [userPoolClient],
      })

      const meIntegration = new HttpLambdaIntegration('MeIntegration', meLambda);

      api.addRoutes({
        path: '/me',
        methods: [HttpMethod.GET],
        integration: meIntegration,
        authorizer: authorizer, // This enforces the 401 before Lambda is invoked
        authorizationScopes: ['aws.cognito.signin.user.admin'],
      })

      new cdk.CfnOutput(this, 'UserPoolIdOutput', {
        value: userPool.userPoolId, 
        description: 'The ID of the Cognito User Pool',
      })

      new cdk.CfnOutput(this, 'UserPoolClientIdOutput', {
        value: userPoolClient.userPoolClientId, 
        description: 'The Client ID for the App Client',
      })   
      
      new cdk.CfnOutput(this, 'ApiUrlOutput', {
        value: api.apiEndpoint,
        description: 'The URL of the HTTP API',
      });
  }
}
