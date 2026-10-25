import { describe, expect, it } from "bun:test";
import { createOvhClient, isOvhNotFound, signOvhRequest } from "../src/ovh";
import {
  buildRcloneConfig,
  buildSyncPolicy,
  createKeyedLock,
} from "../src/syncCredentials";

describe("signOvhRequest", () => {
  it("signs a request with a body: $1$ + sha1(secret+consumer+method+url+body+ts)", () => {
    expect(
      signOvhRequest({
        applicationSecret: "test-app-secret",
        consumerKey: "test-consumer-key",
        method: "POST",
        url: "https://ca.api.ovh.com/1.0/cloud/project/pid123/user",
        body: '{"description":"jivedrive:alice","role":"objectstore_operator"}',
        timestamp: 1761350400,
      }),
    ).toBe("$1$2ce6776b6358a5b6f9e95375a6f0279f0535c63c");
  });

  it("signs a request without a body using an empty string", () => {
    expect(
      signOvhRequest({
        applicationSecret: "test-app-secret",
        consumerKey: "test-consumer-key",
        method: "GET",
        url: "https://ca.api.ovh.com/1.0/cloud/project/pid123/user/42",
        body: "",
        timestamp: 1761350400,
      }),
    ).toBe("$1$72714309e4d2cbf910f9dde56a8a396be0d76786");
  });
});

describe("createOvhClient", () => {
  const ovhConfig = {
    endpoint: "https://ca.api.ovh.com/1.0",
    applicationKey: "app-key",
    applicationSecret: "test-app-secret",
    consumerKey: "test-consumer-key",
    projectId: "pid123",
  };

  it("sends signed requests with the OVH headers and exact JSON body", async () => {
    const requests: Request[] = [];
    const client = createOvhClient(ovhConfig, {
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json({
          id: 42,
          username: "user-x",
          status: "creating",
        });
      },
      now: () => 1761350400_000,
    });

    const created = await client.createUser("jivedrive:alice");

    expect(created).toEqual({ id: "42" });
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://ca.api.ovh.com/1.0/cloud/project/pid123/user",
    );
    expect(await request.text()).toBe(
      '{"description":"jivedrive:alice","role":"objectstore_operator"}',
    );
    expect(request.headers.get("X-Ovh-Application")).toBe("app-key");
    expect(request.headers.get("X-Ovh-Consumer")).toBe("test-consumer-key");
    expect(request.headers.get("X-Ovh-Timestamp")).toBe("1761350400");
    expect(request.headers.get("X-Ovh-Signature")).toBe(
      "$1$2ce6776b6358a5b6f9e95375a6f0279f0535c63c",
    );
  });

  it("turns an OVH error response into an error carrying status and message", async () => {
    const client = createOvhClient(ovhConfig, {
      fetch: async () =>
        Response.json(
          { class: "Client::NotFound", message: "The key does not exist" },
          { status: 404 },
        ),
    });

    let caught: unknown;
    try {
      await client.deleteS3Credential("42", "AK1");
    } catch (error) {
      caught = error;
    }
    expect(isOvhNotFound(caught)).toBe(true);
    expect((caught as Error).message).toContain("The key does not exist");
  });

  it("gives up waiting for a user that never becomes ok", async () => {
    const client = createOvhClient(ovhConfig, {
      fetch: async () => Response.json({ id: 42, status: "creating" }),
      pollIntervalMs: 1,
      pollTimeoutMs: 20,
    });
    await expect(client.waitForUserReady("42")).rejects.toThrow(/ready/);
  });
});

describe("buildSyncPolicy", () => {
  it("scopes listing and object access to the prefix", () => {
    expect(
      JSON.parse(buildSyncPolicy("jivedrive-prod", "users/alice/")),
    ).toEqual({
      Statement: [
        {
          Sid: "ListOwnPrefix",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: ["arn:aws:s3:::jivedrive-prod"],
          Condition: { StringLike: { "s3:prefix": ["users/alice/*"] } },
        },
        {
          Sid: "OwnObjects",
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:ListMultipartUploadParts",
            "s3:AbortMultipartUpload",
          ],
          Resource: ["arn:aws:s3:::jivedrive-prod/users/alice/*"],
        },
        {
          Sid: "DenyListBuckets",
          Effect: "Deny",
          Action: ["s3:ListAllMyBuckets"],
          Resource: ["*"],
        },
      ],
    });
  });

  it("grants the whole bucket for an empty prefix", () => {
    const policy = JSON.parse(buildSyncPolicy("jivedrive-prod", "")) as {
      Statement: Array<{
        Sid: string;
        Resource: string[];
        Condition?: unknown;
      }>;
    };
    const list = policy.Statement.find((s) => s.Sid === "ListOwnPrefix")!;
    expect(list.Resource).toEqual(["arn:aws:s3:::jivedrive-prod"]);
    expect(list.Condition).toBeUndefined();
    expect(
      policy.Statement.find((s) => s.Sid === "OwnObjects")!.Resource,
    ).toEqual(["arn:aws:s3:::jivedrive-prod/*"]);
  });

  it("rejects a prefix containing a wildcard character", () => {
    expect(() => buildSyncPolicy("jivedrive-prod", "users/a*/")).toThrow();
    expect(() => buildSyncPolicy("jivedrive-prod", "users/a?/")).toThrow();
  });
});

describe("buildRcloneConfig", () => {
  const base = {
    endpoint: "https://s3.ca-east-tor.io.cloud.ovh.net",
    region: "ca-east-tor",
    accessKeyId: "AKEXAMPLE",
    secretAccessKey: "SECRETEXAMPLE",
    bucket: "jivedrive-prod",
  };

  it("builds an s3 remote plus an alias ending in the prefix", () => {
    expect(buildRcloneConfig({ ...base, prefix: "users/alice/" })).toBe(
      [
        "[jivedrive-s3]",
        "type = s3",
        "provider = Other",
        "endpoint = https://s3.ca-east-tor.io.cloud.ovh.net",
        "region = ca-east-tor",
        "access_key_id = AKEXAMPLE",
        "secret_access_key = SECRETEXAMPLE",
        "no_check_bucket = true",
        "",
        "[jivedrive]",
        "type = alias",
        "remote = jivedrive-s3:jivedrive-prod/users/alice/",
        "",
      ].join("\n"),
    );
  });

  it("points the alias at the bucket for an empty prefix", () => {
    expect(buildRcloneConfig({ ...base, prefix: "" })).toContain(
      "remote = jivedrive-s3:jivedrive-prod\n",
    );
  });
});

describe("createKeyedLock", () => {
  it("serialises work per key and lets other keys run concurrently", async () => {
    const lock = createKeyedLock();
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = lock.run("alice", async () => {
      events.push("alice-1 start");
      await gate.promise;
      events.push("alice-1 end");
    });
    const second = lock.run("alice", async () => {
      events.push("alice-2 start");
    });
    const other = lock.run("bob", async () => {
      events.push("bob start");
    });
    await other;
    expect(events).toEqual(["alice-1 start", "bob start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "alice-1 start",
      "bob start",
      "alice-1 end",
      "alice-2 start",
    ]);
  });

  it("releases the key when the work throws", async () => {
    const lock = createKeyedLock();
    await expect(
      lock.run("alice", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lock.run("alice", async () => "next")).toBe("next");
  });
});
