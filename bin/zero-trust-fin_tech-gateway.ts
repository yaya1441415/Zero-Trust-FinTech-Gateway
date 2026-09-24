#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ZeroTrustFinTechGatewayStack } from '../lib/zero-trust-fin_tech-gateway-stack';

const app = new cdk.App();
new ZeroTrustFinTechGatewayStack(app, 'ZeroTrustFinTechGatewayStack', {

  
});
