import { aws_iam, aws_kms, aws_lambda, aws_lambda_event_sources, aws_rds, aws_s3, aws_sns, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from "path";

export enum RdsEventId {
  DB_AUTOMATED_AURORA_SNAPSHOT_CREATED = "RDS-EVENT-0169",
  DB_AUTOMATED_SNAPSHOT_CREATED = "RDS-EVENT-0091",
  DB_MANUAL_SNAPSHOT_CREATED = "RDS-EVENT-0042",
  DB_BACKUP_SNAPSHOT_FINISHED_COPY = "RDS-EVENT-0197",
}

export enum RdsSnapshotType {
  DB_AUTOMATED_SNAPSHOT = "AUTOMATED",
  DB_BACKUP_SNAPSHOT = "BACKUP",
  DB_MANUAL_SNAPSHOT = "MANUAL"
}

export interface RdsSnapshot {
  rdsEventId: RdsEventId;
  rdsSnapshotType: RdsSnapshotType;
}

export interface RdsSnapshotExportPipelineStackProps extends StackProps {
  readonly s3BucketName: string;
  readonly dbName: string;
  readonly rdsEvents: Array<RdsSnapshot>;
}

export class RdsSnapshotExportPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: RdsSnapshotExportPipelineStackProps, kmsKeyArn: string) {
    super(scope, id, props);

    // 1. Create KMS Keys first
    const snapshotExportEncryptionKey = new aws_kms.Key(this, "SnapshotExportEncryptionKey", {
      alias: props.dbName + "-snapshot-exports",
      enableKeyRotation: true,
    });

    // 2. Create base roles without policies
    const snapshotExportTaskRole = new aws_iam.Role(this, "SnapshotExportTaskRole", {
      assumedBy: new aws_iam.ServicePrincipal("export.rds.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
    });

    const snapshotExportGlueCrawlerRole = new aws_iam.Role(this, "SnapshotExportsGlueCrawlerRole", {
      assumedBy: new aws_iam.ServicePrincipal("glue.amazonaws.com"),
      description: "Role used by Glue to crawl snapshot exports",
    });

    const lambdaExecutionRole = new aws_iam.Role(this, "RdsSnapshotExporterLambdaExecutionRole", {
      assumedBy: new aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      description: 'RdsSnapshotExportToS3 Lambda execution role for the "' + props.dbName + '" database.',
    });

    lambdaExecutionRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          "rds:StartExportTask",
          "rds:DescribeDBSnapshots",
          "rds:DescribeDBClusterSnapshots"
        ],
        resources: ["*"]  // You can restrict this to specific snapshot ARNs if needed
      })
    );
    
    // Add CloudWatch Logs permissions
    lambdaExecutionRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ],
        resources: ["*"]
      })
    );

    // Add iam:PassRole permission
    lambdaExecutionRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [snapshotExportTaskRole.roleArn],  // Scope to specific role ARN
      })
    );

    // 3. Create S3 bucket
    const bucket = new aws_s3.Bucket(this, "SnapshotExportBucket", {
      bucketName: props.s3BucketName,
      blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: aws_s3.BucketEncryption.KMS,
      encryptionKey: snapshotExportEncryptionKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const destinationBucket = aws_s3.Bucket.fromBucketName(
      this,
      "SnapshotExportBucketSaEast1", 
      `${props.s3BucketName}-sa-east-1`
    );

    // 4. Create replication role
    const replicationRole = new aws_iam.Role(this, 'ReplicationRole', {
      assumedBy: new aws_iam.ServicePrincipal('s3.amazonaws.com'),
    });

    // 5. Add policies to roles
    snapshotExportTaskRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          "s3:PutObject*",
          "s3:ListBucket",
          "s3:GetObject*",
          "s3:DeleteObject*",
          "s3:GetBucketLocation"
        ],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      })
    );

    replicationRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          's3:GetReplicationConfiguration',
          's3:ListBucket',
          's3:GetObjectVersionForReplication',
          's3:GetObjectVersionAcl',
          's3:GetObjectVersionTagging',
          's3:GetObjectVersion'
        ],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`]
      })
    );

    replicationRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          's3:ReplicateObject',
          's3:ReplicateDelete',
          's3:ReplicateTags',
          's3:ObjectOwnerOverrideToBucketOwner'
        ],
        resources: [
          destinationBucket.bucketArn,
          `${destinationBucket.bucketArn}/*`
        ]
      })
    );

    // Add KMS permissions to replication role
    replicationRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          'kms:Decrypt'
        ],
        resources: [snapshotExportEncryptionKey.keyArn]
      })
    );

    replicationRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          'kms:Encrypt',
          'kms:GenerateDataKey*'
        ],
        resources: [kmsKeyArn] // destination KMS key ARN
      })
    );

    // 6. Add KMS permissions
    snapshotExportEncryptionKey.addToResourcePolicy(
      new aws_iam.PolicyStatement({
        principals: [
          new aws_iam.ArnPrincipal(lambdaExecutionRole.roleArn),
          new aws_iam.ArnPrincipal(snapshotExportGlueCrawlerRole.roleArn),
          replicationRole
        ],
        actions: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          'kms:CreateGrant',  
          'kms:ListGrants',  
          "kms:DescribeKey"
        ],
        resources: ["*"]
      })
    );

    // Add to the source KMS key policy
    snapshotExportEncryptionKey.addToResourcePolicy(
      new aws_iam.PolicyStatement({
        principals: [replicationRole],
        actions: [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ],
        resources: ["*"]
      })
    );

    // 7. Configure bucket replication
    const cfnBucket = bucket.node.defaultChild as aws_s3.CfnBucket;
    cfnBucket.replicationConfiguration = {
      role: replicationRole.roleArn,
      rules: [{
        id: 'CrossRegionReplicationRule',
        status: 'Enabled',
        destination: {
          bucket: destinationBucket.bucketArn,
          encryptionConfiguration: {
            replicaKmsKeyId: kmsKeyArn
          },
          account: Stack.of(this).account,
          accessControlTranslation: {
            owner: 'Destination'
          }
        },
        sourceSelectionCriteria: {
          sseKmsEncryptedObjects: {
            status: 'Enabled'
          }
        }
      }]
    };

    // 8. Create SNS topic and Lambda last
    const snapshotEventTopic = new aws_sns.Topic(this, "SnapshotEventTopic", {
      displayName: "rds-snapshot-creation"
    });

    new aws_lambda.Function(this, "LambdaFunction", {
      functionName: props.dbName + "-rds-snapshot-exporter",
      runtime: aws_lambda.Runtime.PYTHON_3_8,
      handler: "main.handler",
      code: aws_lambda.Code.fromAsset(path.join(__dirname, "/../assets/exporter/")),
      environment: {
        RDS_EVENT_IDS: props.rdsEvents.map(e => e.rdsEventId).join(','),
        RDS_SNAPSHOT_TYPES: props.rdsEvents.map(e => e.rdsSnapshotType).join(','),
        DB_NAME: props.dbName,
        LOG_LEVEL: "INFO",
        SNAPSHOT_BUCKET_NAME: bucket.bucketName,
        SNAPSHOT_TASK_ROLE: snapshotExportTaskRole.roleArn,
        SNAPSHOT_TASK_KEY: snapshotExportEncryptionKey.keyArn,
        DB_SNAPSHOT_TYPES: props.rdsEvents
          .map(e => e.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED ? 
            "cluster-snapshot" : "snapshot")
          .join(',')
      },
      role: lambdaExecutionRole,
      timeout: Duration.seconds(30),
      events: [
        new aws_lambda_event_sources.SnsEventSource(snapshotEventTopic)
      ]
    });

    // 9. Configure RDS event subscriptions last
    if (props.rdsEvents.find(rdsEvent => 
      rdsEvent.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED)) {
      new aws_rds.CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
        snsTopicArn: snapshotEventTopic.topicArn,
        enabled: true,
        eventCategories: ['backup'],
        sourceType: 'db-cluster-snapshot',
      });
    } else {
      new aws_rds.CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
        snsTopicArn: snapshotEventTopic.topicArn,
        enabled: true,
        eventCategories: ['creation'],
        sourceType: 'db-snapshot',
      });
    }
  }
}