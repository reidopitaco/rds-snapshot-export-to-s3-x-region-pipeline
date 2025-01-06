## RDS Snapshot Export to S3 Pipeline

This repository creates the automation necessary to export Amazon RDS snapshots to S3 for multiple databases whenever a snapshot is created, whether created by an automated snapshot, manual, or by AWS Backup service. The solution supports cross-region replication of snapshots from us-east-1 to sa-east-1.

## Usage

1. Install the [Amazon Cloud Development Kit](https://aws.amazon.com/cdk/) (CDK).
2. Clone this repository and `cd` into it.
3. Modify the database configurations in `$/bin/cdk.ts`. The stack supports multiple databases through an array:
    ```typescript
    const databases = [
      'database1-production-psql',
      'database2-production-psql'
    ];
    ```

4. For each database, two stacks will be created:
   * A destination bucket stack in sa-east-1 (`RdsSnapshotDestinationBucket-<baseName>`)
   * An export pipeline stack in us-east-1 (`RdsSnapshotExportToS3Pipeline-<baseName>`)

   Where `<baseName>` is extracted from the database name (e.g., 'database1' from 'database1-production-psql')

5. The destination bucket stack (`DestinationBucketStack`) creates:
   * An S3 bucket in sa-east-1 with the naming pattern `s3-rds-rdp-<baseName>-sa-east-1`
   * A KMS key for encryption
   * Required IAM policies for cross-region replication

6. The export pipeline stack (`RdsSnapshotExportPipelineStack`) configures:
   * Source S3 bucket in us-east-1
   * Cross-region replication to the destination bucket
   * Lambda function for snapshot export
   * Required IAM roles and policies
   * SNS topic for RDS events

7. Configure the `rdsEvents` array for each database to specify which snapshot types to export:
    ```typescript
    rdsEvents: [
      {
        rdsEventId: RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED,
        rdsSnapshotType: RdsSnapshotType.DB_AUTOMATED_SNAPSHOT
      },
      {
        rdsEventId: RdsEventId.DB_MANUAL_SNAPSHOT_CREATED,
        rdsSnapshotType: RdsSnapshotType.DB_MANUAL_SNAPSHOT
      }
    ]
    ```

8. Execute the following:
    * `npm install`
    * `npm run cdk bootstrap`
    * `npm run cdk deploy`

9. For each database, configure a test event in the corresponding Lambda function (`<dbName>-rds-snapshot-exporter`) using the contents of [$/event.json](./event.json) or [$/event.aurora.json](./event.aurora.json) as a template.

You can monitor export progress in the [Exports in Amazon S3](https://console.aws.amazon.com/rds/home#snapshots-list:tab=exporttos3) listing. Exported snapshots will be automatically replicated to the corresponding sa-east-1 bucket.

## Cleanup

Execute `npm run cdk destroy` to delete resources pertaining to this example.

You will also need to delete the following manually:
   * The S3 buckets created in both us-east-1 and sa-east-1 regions
   * The KMS keys created for encryption
   * The [CDKToolkit CloudFormation Stack](https://console.aws.amazon.com/cloudformation/home#/stacks?filteringText=CDKToolkit)
   * The `cdktoolkit-stagingbucket-<...>` bucket

## License

This library is licensed under the MIT-0 License. See the [LICENSE](./LICENSE) file.
