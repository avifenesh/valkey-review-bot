#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { addValkeyReviewerStacks } from '../lib/app';
import { loadDeploymentConfig } from '../lib/deployment-config';

const app = new cdk.App();
const config = loadDeploymentConfig(app.node.tryGetContext('config'), process.env);
addValkeyReviewerStacks(app, config);
