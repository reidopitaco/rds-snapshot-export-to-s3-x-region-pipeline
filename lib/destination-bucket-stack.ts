import { aws_iam, aws_kms, aws_s3, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface DestinationBucketStackProps extends StackProps {
    /**
     * Name of the S3 bucket to be created
     *
     * NOTE: Bucket will be created if one does not already exist.
     */
    readonly bucketName: string;
  
  };

export class DestinationBucketStack extends Stack {
  public readonly bucket: aws_s3.Bucket;
  public readonly kmsKey: aws_kms.Key;

  constructor(scope: Construct, id: string, props?: DestinationBucketStackProps) {
    super(scope, id, {
      ...props,
      env: {
        region: 'sa-east-1', // Explicitly set the region
        account: process.env.CDK_DEFAULT_ACCOUNT,
      },
    });

    // Create KMS key first
    this.kmsKey = new aws_kms.Key(this, 'DestinationKey', {
        alias: `${props?.bucketName}-key`,
        removalPolicy: RemovalPolicy.RETAIN,
        enableKeyRotation: true,
      });

    this.bucket = new aws_s3.Bucket(this, "SnapshotExportBucketSaEast1", {
      bucketName: `${props?.bucketName}-sa-east-1`,
      blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      encryption: aws_s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey, 
    });

    this.kmsKey.addToResourcePolicy(
      new aws_iam.PolicyStatement({
        principals: [new aws_iam.AccountPrincipal(process.env.CDK_DEFAULT_ACCOUNT!)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
          'kms:RetireGrant',
          'kms:CreateGrant',  
          'kms:ListGrants',   
          'kms:ListGrants'
        ],
        resources: ['*']
      })
    );

    this.bucket.addToResourcePolicy(
      new aws_iam.PolicyStatement({
        principals: [new aws_iam.AccountPrincipal(process.env.CDK_DEFAULT_ACCOUNT!)],
        actions: [
          's3:ReplicateObject',
          's3:ReplicateDelete',
          's3:ReplicateTags',
          's3:ObjectOwnerOverrideToBucketOwner',
          's3:GetObjectVersionForReplication',
          's3:GetObjectVersionTagging'
        ],
        resources: [
          this.bucket.bucketArn,
          `${this.bucket.bucketArn}/*`
        ]
      })
    );
  }
}