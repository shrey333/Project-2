import boto3
import json
from botocore.exceptions import ClientError
from face_recognition import face_match
from pathlib import Path

# Create SQS client
sqs = boto3.client("sqs")

# SQS queue URLs
req_queue_url = "https://sqs.us-east-1.amazonaws.com/381491829413/1229892289-req-queue"
resp_queue_url = (
    "https://sqs.us-east-1.amazonaws.com/381491829413/1229892289-resp-queue"
)

while True:
    try:
        # Receive message from SQS queue
        response = sqs.receive_message(
            QueueUrl=req_queue_url,
            AttributeNames=["SentTimestamp"],
            MaxNumberOfMessages=1,
            MessageAttributeNames=["All"],
            VisibilityTimeout=0,
            WaitTimeSeconds=0,
        )

        # Check if there are any messages
        if "Messages" in response:
            # Process the first message
            message = response["Messages"][0]
            correlation_id = message["MessageAttributes"]["CorrelationId"][
                "StringValue"
            ]
            receipt_handle = message["ReceiptHandle"]

            # Delete the processed message from the queue
            sqs.delete_message(QueueUrl=req_queue_url, ReceiptHandle=receipt_handle)

            # Access the image file from S3
            s3 = boto3.client("s3")
            response = s3.get_object(
                Bucket="1229892289-in-bucket",
                Key=message["Body"],
            )

            try:
                # Perform face recognition on the image
                result = face_match(response["Body"], "data.pt")

                # Store the result in an output bucket
                response = s3.put_object(
                    Bucket="1229892289-out-bucket",
                    Key=Path(message["Body"]).stem,
                    Body=result[0],
                )

                # Send the result back to the response queue
                response = sqs.send_message(
                    QueueUrl=resp_queue_url,
                    MessageBody=f"{Path(message['Body']).stem}:{result[0]}",
                    MessageAttributes={
                        "CorrelationId": {
                            "DataType": "String",
                            "StringValue": correlation_id,
                        },
                    },
                )

            except Exception as e:
                # Handle errors related to face recognition
                print("Error processing image:", str(e))

    except ClientError as e:
        # Handle errors related to SQS operations
        print("Error receiving message from SQS:", str(e))
