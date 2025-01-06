#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { DestinationBucketStack } from '../lib/destination-bucket-stack';
import { RdsEventId, RdsSnapshotExportPipelineStack, RdsSnapshotType } from '../lib/rds-snapshot-export-pipeline-stack';

const app = new cdk.App();

// Enable cross-region references
const env = { 
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

const stackProps: cdk.StackProps = {
  crossRegionReferences: true,  // Add this line
};

// Define database configurations
const databases = [
  'userbets0-production-psql',
  'userbets1-production-psql',
  'betting-production-psql'
];

// Create destination buckets in sa-east-1
databases.forEach(dbName => {
  // Extract base name for S3 bucket (e.g., 'userbets0' from 'userbets0-production-psql')
  const baseName = dbName.split('-')[0];
  const bucketBaseName = `s3-rds-rdp-${baseName}`;

  // Create destination bucket stack
  var destinationBucketStack = new DestinationBucketStack(app, `RdsSnapshotDestinationBucket-${baseName}`, {
    bucketName: bucketBaseName,
    env: {
      ...env,
      region: 'sa-east-1',
    },
    ...stackProps
  });

  var kmsKeyArn = destinationBucketStack.kmsKey.keyArn;

  // Create export pipeline stack
  new RdsSnapshotExportPipelineStack(app, `RdsSnapshotExportToS3Pipeline-${baseName}`, {
    dbName: dbName,
    rdsEvents: [
      {
        rdsEventId: RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED, 
        rdsSnapshotType: RdsSnapshotType.DB_AUTOMATED_SNAPSHOT
      },
      {
        rdsEventId: RdsEventId.DB_MANUAL_SNAPSHOT_CREATED,
        rdsSnapshotType: RdsSnapshotType.DB_MANUAL_SNAPSHOT
      },
    ],
    s3BucketName: bucketBaseName,
    env: {
      ...env,
      region: 'us-east-1',
    },
    ...stackProps,
  }, kmsKeyArn);
});