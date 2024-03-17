import fs from "fs";
import path from "path";
import multer from "multer";
import express, { response } from "express";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

const __dirname = path.resolve();

const app = express();
const port = 8000;
const s3Client = new S3Client({ region: "us-east-1" });
const sqsClient = new SQSClient({ region: "us-east-1" });
const ec2Client = new EC2Client({ region: "us-east-1" });
const inBucketName = "1229892289-in-bucket";
const reqQueueUrl =
  "https://sqs.us-east-1.amazonaws.com/381491829413/1229892289-req-queue";
const respQueueUrl =
  "https://sqs.us-east-1.amazonaws.com/381491829413/1229892289-resp-queue";

const userData = `Content-Type: multipart/mixed; boundary="//"
MIME-Version: 1.0

--//
Content-Type: text/cloud-config; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="cloud-config.txt"

#cloud-config
cloud_final_modules:
- [scripts-user, always]

--//
Content-Type: text/x-shellscript; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="userdata.txt"

#!/bin/bash
source /home/ubuntu/env/bin/activate
python3 /home/ubuntu/app-tier.py >> /home/ubuntu/out.txt 2>&1
--//--
`;

const createUploadsFolderIfNotExists = (req, res, next) => {
  const uploadDir = path.join(__dirname, "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }
  next();
};

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
let cache = [];
let instances = [];
let numOfRequest = 0;

const getMessageCount = () => {
  const response = sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: reqQueueUrl,
      AttributeNames: ["ApproximateNumberOfMessages"],
    })
  );
  return parseInt(response.Attributes.ApproximateNumberOfMessages);
};

const startInstance = async (num) => {
  const instanceParams = {
    ImageId: "ami-011b4bebf6d36d509",
    InstanceType: "t2.micro",
    KeyName: "developmentIAM",
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData).toString("base64"),
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [{ Key: "Name", Value: `app-tier-instance-${num}` }],
      },
    ],
    IamInstanceProfile: {
      Name: "s3-sqs-role",
    },
  };

  const command = new RunInstancesCommand(instanceParams);
  const response = await ec2Client.send(command);
  instances.push(response.Instances[0].InstanceId);
};

const stopInstances = async () => {
  const params = {
    InstanceIds: instances,
  };
  await ec2Client.send(new TerminateInstancesCommand(params));
};

app.post(
  "/",
  createUploadsFolderIfNotExists,
  upload.single("inputFile"),
  async (req, res) => {
    const num = numOfRequest + 1;
    numOfRequest += 1;
    const file = req.file;
    if (!file) {
      return res.status(400).send("No file uploaded.");
    }

    var objectParams = {
      Bucket: inBucketName,
      Key: file.originalname,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    await s3Client.send(new PutObjectCommand(objectParams));

    const CorrelationId = randomUUID();

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: reqQueueUrl,
        MessageBody: file.originalname,
        MessageAttributes: {
          CorrelationId: {
            DataType: "String",
            StringValue: CorrelationId,
          },
        },
      })
    );

    if (num < 20) {
      await startInstance(num);
    }

    try {
      while (true) {
        const params = {
          QueueUrl: respQueueUrl,
          MessageAttributeNames: ["All"],
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 20,
          WaitTimeSeconds: 20, // Long-polling to reduce API calls
        };

        const data = await sqsClient.send(new ReceiveMessageCommand(params));

        if (data.Messages) {
          cache = [...cache, ...data.Messages];
        }
        const isMsg = cache.find(
          (message) =>
            message.MessageAttributes.CorrelationId.StringValue ===
            CorrelationId
        );

        if (isMsg) {
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: respQueueUrl,
              ReceiptHandle: isMsg.ReceiptHandle,
            })
          );
          res.send(isMsg.Body);
          numOfRequest -= 1;
          if (numOfRequest === 0) {
            // stop instances
            await stopInstances();
          }
          break;
        }
      }
    } catch (err) {
      console.error("Error polling for requests:", err);
      res.status(500).send("Error polling for requests");
    }

    // return res.send("File uploaded to S3 and message sent to SQS");
  }
);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
