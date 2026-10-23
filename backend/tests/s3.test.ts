import { describe, expect, it } from "bun:test";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  assertKeyInScope,
  copyObject,
  createFolderMarker,
  createS3Client,
  deleteObject,
  folderExists,
  headObject,
  listObjects,
  presignedGetUrl,
  presignedPutUrl,
} from "../src/s3/client";
import type { AppConfig } from "../src/config";

/**
 * Build a stub S3 client. The AWS SDK dispatches commands through
 * `client.send(command)`; the stub routes by command constructor name.
 */
function stubClient(
  handler: (commandName: string, input: Record<string, unknown>) => unknown,
): S3Client {
  return {
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor
        .name;
      const input = (command as { input: Record<string, unknown> }).input ?? {};
      return handler(name, input);
    },
  } as unknown as S3Client;
}

/** An S3 input with a helper for asserting what the wrapper sent. */
function s3Input(
  handler: (commandName: string, input: Record<string, unknown>) => unknown,
): {
  client: S3Client;
  calls: Array<{ name: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = stubClient((name, input) => {
    calls.push({ name, input });
    return handler(name, input);
  });
  return { client, calls };
}

const userPrefix = "users/alice/";
const bucket = "jivedrive-prod";

/** A minimal S3 config for creating a real client used in presign tests. */
const s3Config: AppConfig["s3"] = {
  endpoint: "https://s3.gra.io.cloud.ovh.net",
  region: "gra",
  accessKeyId: "AKIAEXAMPLE123",
  secretAccessKey: "s3cr3t",
};

describe("assertKeyInScope", () => {
  it("accepts keys inside the user's prefix", () => {
    expect(() =>
      assertKeyInScope(userPrefix, "users/alice/a.txt"),
    ).not.toThrow();
    expect(() =>
      assertKeyInScope(userPrefix, "users/alice/sub/b.txt"),
    ).not.toThrow();
  });

  it("rejects keys outside the user's prefix", () => {
    expect(() => assertKeyInScope(userPrefix, "users/bob/a.txt")).toThrow(
      RangeError,
    );
    expect(() => assertKeyInScope(userPrefix, "a.txt")).toThrow(RangeError);
  });

  it("rejects keys that merely share a name prefix with the user's prefix", () => {
    // "users/alice.txt" starts with "users/alice" but is not under "users/alice/".
    expect(() => assertKeyInScope(userPrefix, "users/alice.txt")).toThrow(
      RangeError,
    );
  });

  it("accepts a key equal to the user's prefix", () => {
    expect(() => assertKeyInScope(userPrefix, "users/alice/")).not.toThrow();
  });

  it("rejects keys containing a .. segment even inside the prefix (T054)", () => {
    // These keys string-prefix-match the user's prefix but contain a
    // parent-traversal segment, so they must be refused.
    for (const key of ["users/alice/../bob.txt", "users/alice/a/../../x"]) {
      expect(() => assertKeyInScope(userPrefix, key)).toThrow(RangeError);
    }
  });
});

describe("createS3Client", () => {
  it("configures the OVHcloud endpoint, region and path-style addressing", async () => {
    const client = createS3Client(s3Config);
    const config = client.config;

    const endpoint = await (
      config.endpoint as () => Promise<{ hostname: string }>
    )();
    expect(endpoint.hostname).toContain("s3.gra.io.cloud.ovh.net");
    expect(await (config.region as () => Promise<string>)()).toBe("gra");
    expect(config.forcePathStyle).toBe(true);
  });
});

describe("listObjects", () => {
  it("separates folders from files and maps sizes and timestamps", async () => {
    const { client, calls } = s3Input((name) => {
      expect(name).toBe("ListObjectsV2Command");
      return {
        Contents: [
          {
            Key: "users/alice/a.txt",
            Size: 10,
            LastModified: new Date("2026-08-12T00:00:00Z"),
          },
          {
            Key: "users/alice/c.txt",
            Size: 20,
            LastModified: new Date("2026-08-13T00:00:00Z"),
          },
        ],
        CommonPrefixes: [{ Prefix: "users/alice/sub/" }],
        IsTruncated: false,
      };
    });

    const result = await listObjects(client, bucket, userPrefix, "");
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/alice/",
      Delimiter: "/",
      MaxKeys: 1000,
    });

    expect(result.folders).toEqual(["sub"]);
    expect(result.files).toEqual([
      {
        key: "users/alice/a.txt",
        name: "a.txt",
        size: 10,
        lastModified: "2026-08-12T00:00:00.000Z",
      },
      {
        key: "users/alice/c.txt",
        name: "c.txt",
        size: 20,
        lastModified: "2026-08-13T00:00:00.000Z",
      },
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("lists a relative subfolder by joining it to the user prefix", async () => {
    const { client, calls } = s3Input(() => ({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: false,
    }));

    await listObjects(client, bucket, userPrefix, "docs/reports");
    expect(calls[0]?.input).toMatchObject({
      Prefix: "users/alice/docs/reports/",
    });
  });

  it("reports the continuation token when the listing is truncated", async () => {
    const { client } = s3Input(() => ({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: true,
      NextContinuationToken: "token-2",
    }));

    const result = await listObjects(client, bucket, userPrefix, "");
    expect(result.nextCursor).toBe("token-2");
  });

  it("passes a continuation token back to S3 for the next page", async () => {
    const { client, calls } = s3Input(() => ({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: false,
    }));

    await listObjects(client, bucket, userPrefix, "", { cursor: "token-1" });
    expect(calls[0]?.input).toMatchObject({ ContinuationToken: "token-1" });
  });

  it("honours an injectable page size (defaults to 1000)", async () => {
    const { client, calls } = s3Input(() => ({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: false,
    }));

    await listObjects(client, bucket, userPrefix, "", { pageSize: 5 });
    expect(calls[0]?.input).toMatchObject({ MaxKeys: 5 });
  });

  it("returns an empty listing for an empty prefix", async () => {
    const { client } = s3Input(() => ({
      Contents: [],
      CommonPrefixes: [],
      IsTruncated: false,
    }));

    const result = await listObjects(client, bucket, userPrefix, "");
    expect(result).toEqual({ folders: [], files: [], nextCursor: null });
  });

  it("derives folder names one level deep from the listing prefix", async () => {
    const { client } = s3Input(() => ({
      Contents: [],
      CommonPrefixes: [{ Prefix: "users/alice/deep/nested/" }],
      IsTruncated: false,
    }));

    const result = await listObjects(client, bucket, userPrefix, "");
    expect(result.folders).toEqual(["deep"]);
  });
});

describe("headObject", () => {
  it("returns size and last modified for an existing object", async () => {
    const { client, calls } = s3Input(() => ({
      ContentLength: 1234,
      LastModified: new Date("2026-08-12T00:00:00Z"),
    }));

    const result = await headObject(
      client,
      bucket,
      userPrefix,
      "users/alice/a.txt",
    );
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/a.txt",
    });
    expect(result).toEqual({
      key: "users/alice/a.txt",
      size: 1234,
      lastModified: "2026-08-12T00:00:00.000Z",
    });
  });

  it("returns null when the object does not exist", async () => {
    const { client } = s3Input(() => {
      const err = new Error("Not Found") as Error & { name: string };
      err.name = "NotFound";
      throw err;
    });

    expect(
      await headObject(client, bucket, userPrefix, "users/alice/missing.txt"),
    ).toBeNull();
  });

  it("rejects a key outside the user's prefix", async () => {
    const { client } = s3Input(() => ({}));
    await expect(
      headObject(client, bucket, userPrefix, "users/bob/a.txt"),
    ).rejects.toThrow(RangeError);
  });

  it("rejects a key containing a .. segment (T054)", async () => {
    const { client } = s3Input(() => ({}));
    await expect(
      headObject(client, bucket, userPrefix, "users/alice/../bob.txt"),
    ).rejects.toThrow(RangeError);
  });
});

describe("deleteObject", () => {
  it("sends a delete command for the scoped key", async () => {
    const { client, calls } = s3Input(() => ({}));

    await deleteObject(client, bucket, userPrefix, "users/alice/a.txt");
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/a.txt",
    });
  });

  it("rejects a key outside the user's prefix", async () => {
    const { client } = s3Input(() => ({}));
    await expect(
      deleteObject(client, bucket, userPrefix, "users/bob/a.txt"),
    ).rejects.toThrow(RangeError);
  });

  it("rejects a key containing a .. segment (T054)", async () => {
    const { client } = s3Input(() => ({}));
    await expect(
      deleteObject(client, bucket, userPrefix, "users/alice/../bob.txt"),
    ).rejects.toThrow(RangeError);
  });
});

describe("copyObject", () => {
  it("copies within the bucket with a URL-encoded copy source", async () => {
    const { client, calls } = s3Input(() => ({}));

    await copyObject(
      client,
      bucket,
      userPrefix,
      "users/alice/My Docs/r&d #1.txt",
      "users/alice/archive/r&d #1.txt",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("CopyObjectCommand");
    // The source is "bucket/key" with each key segment URL-encoded and
    // the separators kept, so spaces and reserved characters survive.
    expect(calls[0]?.input).toEqual({
      Bucket: bucket,
      Key: "users/alice/archive/r&d #1.txt",
      CopySource: "jivedrive-prod/users/alice/My%20Docs/r%26d%20%231.txt",
    });
  });

  it("rejects a source or destination outside the user's prefix without contacting storage", async () => {
    const { client, calls } = s3Input(() => ({}));

    await expect(
      copyObject(
        client,
        bucket,
        userPrefix,
        "users/bob/a.txt",
        "users/alice/a.txt",
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      copyObject(
        client,
        bucket,
        userPrefix,
        "users/alice/a.txt",
        "users/bob/a.txt",
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      copyObject(
        client,
        bucket,
        userPrefix,
        "users/alice/a.txt",
        "users/alice/../bob/a.txt",
      ),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("presigned URLs", () => {
  const client = createS3Client(s3Config);

  it("generates a presigned GET URL with the requested expiry", async () => {
    const url = await presignedGetUrl(
      client,
      bucket,
      userPrefix,
      "users/alice/a.txt",
      3600,
    );

    expect(url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/a.txt",
    );
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("X-Amz-Signature");
  });

  it("generates a presigned PUT URL with the requested expiry", async () => {
    const url = await presignedPutUrl(
      client,
      bucket,
      userPrefix,
      "users/alice/new.txt",
      300,
    );

    expect(url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/new.txt",
    );
    expect(url).toContain("X-Amz-Expires=300");
    expect(url).toContain("X-Amz-Signature");
  });

  it("URL-encodes special characters in the object key", async () => {
    const url = await presignedGetUrl(
      client,
      bucket,
      userPrefix,
      "users/alice/my file #1?.txt",
      60,
    );

    expect(url).toContain(encodeURIComponent("my file #1?.txt"));
  });

  it("rejects a key outside the user's prefix", async () => {
    await expect(
      presignedGetUrl(client, bucket, userPrefix, "users/bob/a.txt", 60),
    ).rejects.toThrow(RangeError);
  });

  it("rejects a key containing a .. segment (T054)", async () => {
    await expect(
      presignedGetUrl(client, bucket, userPrefix, "users/alice/../bob.txt", 60),
    ).rejects.toThrow(RangeError);
    await expect(
      presignedPutUrl(client, bucket, userPrefix, "users/alice/../bob.txt", 60),
    ).rejects.toThrow(RangeError);
  });
});

describe("folderExists", () => {
  it("reports a folder with at least one object under it", async () => {
    const { client, calls } = s3Input(() => ({
      Contents: [{ Key: "users/alice/docs/" }],
      IsTruncated: false,
    }));

    expect(
      await folderExists(client, bucket, userPrefix, "users/alice/docs/"),
    ).toBe(true);
    // One recursive probe of a single key: no delimiter, so a folder made
    // only of nested objects (no marker) still counts as existing.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("ListObjectsV2Command");
    expect(calls[0]?.input).toEqual({
      Bucket: bucket,
      Prefix: "users/alice/docs/",
      MaxKeys: 1,
    });
  });

  it("reports a folder with no objects under it as missing", async () => {
    const { client } = s3Input(() => ({ IsTruncated: false }));

    expect(
      await folderExists(client, bucket, userPrefix, "users/alice/new/"),
    ).toBe(false);
  });

  it("rejects a folder key outside the user's prefix", async () => {
    const { client, calls } = s3Input(() => ({}));
    await expect(
      folderExists(client, bucket, userPrefix, "users/bob/docs/"),
    ).rejects.toThrow(RangeError);
    await expect(
      folderExists(client, bucket, userPrefix, "users/alice/../bob/"),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("createFolderMarker", () => {
  it("writes a zero-byte marker object at the folder key", async () => {
    const { client, calls } = s3Input(() => ({}));

    await createFolderMarker(client, bucket, userPrefix, "users/alice/new/");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("PutObjectCommand");
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/new/",
      Body: "",
      ContentLength: 0,
    });
  });

  it("rejects a folder key outside the user's prefix", async () => {
    const { client, calls } = s3Input(() => ({}));
    await expect(
      createFolderMarker(client, bucket, userPrefix, "users/bob/new/"),
    ).rejects.toThrow(RangeError);
    await expect(
      createFolderMarker(client, bucket, userPrefix, "users/alice/../bob/"),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});
