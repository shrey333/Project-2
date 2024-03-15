import fs from "fs";
import path from "path";
import multer from "multer";
import express from "express";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

const __dirname = path.resolve();

const app = express();
const port = 8000;
const s3Client = new S3Client({ region: "us-east-1" });
const sqsClient = new SQSClient({ region: "us-east-1" });
const inBucketName = "1229892289-in-bucket";
const reqQueueUrl =
  "https://sqs.us-east-1.amazonaws.com/381491829413/1229892289-req-queue";
const respQueueUrl =
  "https://sqs.us-east-1.amazonaws.com/381491829413/1229892289-resp-queue";

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

app.post(
  "/",
  createUploadsFolderIfNotExists,
  upload.single("inputFile"),
  async (req, res) => {
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

    const response = sqsClient
      .send(
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
      )
      .then((data) => {
        // console.log("Message sent to SQS", data);
      })
      .catch((error) => {
        // console.log("Error sending message to SQS", error);
      });

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
