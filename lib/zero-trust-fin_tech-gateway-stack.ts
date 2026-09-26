import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Service } from 'aws-cdk-lib/aws-servicediscovery';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class ZeroTrustFinTechGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const endpointsOn = this.node.tryGetContext('endpoints') === 'on'


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
      //and with the USER_PASSWORD_AUTH
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

      //Inbound: unreachable => the subnet has no internet Gateway route, lambda has no public IP
      //Outbound: Unreachable because there is no Nat Gateway
    const vpc = new ec2.Vpc(this, 'FinTechVpc', {
        maxAzs:1,
        natGateways:0, //no nat gateaway 
        subnetConfiguration: [
          {
            name: 'Isolated',
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            cidrMask: 24,
          },
        ],
    });
      
      //Inject a route iinto your subnet's route table
    vpc.addGatewayEndpoint('DynamoDbEndpoint', {
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    })


    vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });


    // seurity Group
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
        vpc,
        allowAllOutbound: false, //
        description: 'Security group for Zero Trust Lambda'
    })

      //Allow only HTTPs outbound (needed for VPC Endpoints later, and AWS APIs)
    lambdaSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS outbound');

    const table = new dynamodb.Table(this, 'FinTechTable', {
        partitionKey: {name: 'pk', type: dynamodb.AttributeType.STRING},
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    const meLambda = new NodejsFunction(this, 'MeLambda', {
        entry: 'lambda/me.ts',
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: cdk.Duration.seconds(5),
        vpc: vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [lambdaSg],
        environment: {
          TABLE_NAME: table.tableName,
        },
        bundling: {
          minify: true,
          sourceMap: true,
        },
    })
      
    const meIntegration = new HttpLambdaIntegration('MeIntegration', meLambda);

    const secret = new secretsmanager.Secret(this, 'PaymenApiKey', {
      secretName: 'fintech/payment-api-key',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apiUser: 'fintech-app' }),
        generateStringKey: 'apiKey',
        excludePunctuation: true,
      }
    })

    const maxTransferParam = new ssm.StringParameter(this, 'MaxTransferParam', {
      parameterName: '/fintech/config/max-transfer-amount',
      stringValue: '5000',
    });

    maxTransferParam.grantRead(meLambda);
    meLambda.addEnvironment('PARAM_NAME', maxTransferParam.parameterName);

    if(endpointsOn) {
      vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      })
    }

    table.grantReadWriteData(meLambda);

    secret.grantRead(meLambda)
    meLambda.addEnvironment('SECRET_ARN', secret.secretArn)

    api.addRoutes({
        path: '/me',
        methods: [HttpMethod.GET],
        integration: meIntegration,
        authorizer: authorizer, // This enforces the 401 before Lambda is invoked
        authorizationScopes: ['aws.cognito.signin.user.admin'],
    })

    const dataKey = new kms.Key(this, 'FinTechDataKey', {
      alias: 'alias/fintech-data',
      description: 'Encrypts sensitive fields before they are stored',
      enableKeyRotation: true,
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    vpc.addInterfaceEndpoint('KmsEndpoint',{
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      privateDnsEnabled: true,
      subnets: {subnetType: ec2.SubnetType.PRIVATE_ISOLATED},    
    })

    dataKey.grant(meLambda, 'kms:GenerateDataKey', 'kms:Decrypt');
    meLambda.addEnvironment('KMS_KEY_ARN', dataKey.keyArn)

    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // no public access, ever
      enforceSSL: true,                                   // reject plain HTTP
      encryption: s3.BucketEncryption.KMS,                // encrypt files with your key
      encryptionKey: dataKey,
      bucketKeyEnabled: true,                             // fewer KMS calls, lower cost
      removalPolicy: cdk.RemovalPolicy.DESTROY,           // learning only
      autoDeleteObjects: true,                            // learning only: empties bucket on destroy
    });

    const uploadUrlLambda = new NodejsFunction(this, 'UploadUrlLambda', {
      entry: path.join(__dirname, '..', 'lambda', 'upload-url.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      environment: { BUCKET_NAME: uploadBucket.bucketName },
      bundling: { minify: true, sourceMap: true },
    });

    // Only PutObject, and only under uploads/
    uploadBucket.grantPut(uploadUrlLambda, 'uploads/*');

    api.addRoutes({
      path: '/upload-url',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('UploadUrlIntegration', uploadUrlLambda),
      authorizer: authorizer,
      authorizationScopes: ['aws.cognito.signin.user.admin'],
    })

    const logsBucket = new s3.Bucket(this, 'TransactionLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // For testing, your own account plays the vendor
    const vendorAccount = this.node.tryGetContext('vendorAccount') ?? this.account;
    // In real life, the vendor gives you this value
    const vendorExternalId = this.node.tryGetContext('vendorExternalId') ?? 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

    const vendorBoundary = new iam.ManagedPolicy(this, 'VendorBoundary', {
      description: 'Maximum permissions for any third-party vendor role',
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [logsBucket.bucketArn, logsBucket.arnForObjects('*')],
        }),
      ],
    });

    const vendorRole = new iam.Role(this, 'VendorAnalyticsRole', {
      description: 'Assumed by the analytics vendor to read transaction logs',
      assumedBy: new iam.AccountPrincipal(vendorAccount), // becomes arn:aws:iam::<account>:root
      externalIds: [vendorExternalId],                    // adds the sts:ExternalId condition
      permissionsBoundary: vendorBoundary,
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // The actual grant: read only, and only under transaction-logs/
    logsBucket.grantRead(vendorRole, 'transaction-logs/*');

    new cdk.CfnOutput(this, 'VendorRoleArnOutput', { value: vendorRole.roleArn });
    new cdk.CfnOutput(this, 'LogsBucketOutput', { value: logsBucket.bucketName });

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
