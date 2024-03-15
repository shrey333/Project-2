import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";

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

const client = new EC2Client({ region: "us-east-1" });
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
      Tags: [{ Key: "Name", Value: "app-tier-instance" }],
    },
  ],
  IamInstanceProfile: {
    Name: "s3-sqs-role",
  },
};

const command = new RunInstancesCommand(instanceParams);
const response = client.send(command);
console.log(response.Instances[0].InstanceId);
