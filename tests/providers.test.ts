import { afterEach, describe, expect, it } from "vitest";

import {
  configuredCredentialVariables,
  credentialSource,
  MissingCredentialError,
  requireCredential,
  resolveCredential,
  validateCredentialRef,
} from "@/server/git/credentials";
import {
  azureDevOpsProvider,
  bitbucketProvider,
  detectProvider,
  genericProvider,
  githubProvider,
  gitlabProvider,
  providerFor,
  PROVIDERS,
} from "@/server/git/providers";
import { normalizeRepoUrl, urlTransport, webUrl } from "@/server/git/providers/types";
import { redactRemote } from "@/server/git/workspace";
import { createRepoSchema } from "@/server/validation/schemas";

const SECRET = "s3cr3t-token-value";

describe("detectProvider", () => {
  it("routes each host to its own provider", () => {
    expect(detectProvider("https://github.com/acme/storefront")?.id).toBe("github");
    expect(detectProvider("https://gitlab.com/acme/platform/storefront")?.id).toBe("gitlab");
    expect(detectProvider("https://bitbucket.org/acme/storefront")?.id).toBe("bitbucket");
    expect(detectProvider("https://dev.azure.com/acme/Storefront/_git/storefront")?.id).toBe(
      "azure_devops",
    );
    expect(detectProvider("https://acme.visualstudio.com/Storefront/_git/storefront")?.id).toBe(
      "azure_devops",
    );
  });

  it("matches scp-style and userinfo-bearing remotes", () => {
    expect(detectProvider("git@github.com:acme/storefront.git")?.id).toBe("github");
    expect(detectProvider("https://acme@bitbucket.org/acme/storefront.git")?.id).toBe("bitbucket");
  });

  it("is case-insensitive for Azure DevOps, whose parse lowercases the host", () => {
    // A mixed-case host used to parse but never route, leaving the user with
    // "could not tell which provider that URL belongs to".
    const url = "https://Dev.Azure.com/acme/Storefront/_git/storefront";
    expect(detectProvider(url)?.id).toBe("azure_devops");
    expect(azureDevOpsProvider.parse(url)?.slug).toBe("acme/Storefront/storefront");
  });

  it("claims nothing for an unknown host, so generic must be chosen by hand", () => {
    expect(detectProvider("https://git.example.com/team/project.git")).toBeNull();
    expect(genericProvider.matches("https://github.com/acme/storefront")).toBe(false);
  });

  it("resolves ids, falling back to generic for an unknown stored value", () => {
    for (const provider of PROVIDERS) expect(providerFor(provider.id)).toBe(provider);
    expect(providerFor("gitea").id).toBe("generic");
  });
});

describe("github.parse", () => {
  it("reads owner and repo from every URL form", () => {
    for (const url of [
      "https://github.com/acme/storefront",
      "https://github.com/acme/storefront.git",
      "https://github.com/acme/storefront/",
      "git@github.com:acme/storefront.git",
    ]) {
      expect(githubProvider.parse(url)).toMatchObject({ owner: "acme", repo: "storefront" });
    }
  });

  it("rejects a URL that is not a repository", () => {
    expect(githubProvider.parse("https://example.com/acme/storefront")).toBeNull();
  });
});

describe("gitlab.parse", () => {
  it("keeps the whole namespace path, subgroups included", () => {
    expect(gitlabProvider.parse("https://gitlab.com/acme/platform/storefront")).toMatchObject({
      slug: "acme/platform/storefront",
      projectPath: "acme/platform/storefront",
      owner: "acme",
      repo: "storefront",
    });
  });

  it("cuts a browser URL back at the reserved `-` segment", () => {
    expect(
      gitlabProvider.parse("https://gitlab.com/acme/platform/storefront/-/merge_requests/7")
        ?.projectPath,
    ).toBe("acme/platform/storefront");
  });

  it("accepts a self-managed host and keeps its port", () => {
    // `hostname` would drop the port, which is exactly the deployment the
    // lenient host handling exists for.
    expect(gitlabProvider.parse("https://git.acme.internal:8443/team/project")?.host).toBe(
      "git.acme.internal:8443",
    );
  });

  it("refuses hostnames owned by a sibling provider", () => {
    // Otherwise verifyAccess takes the path out of a GitHub URL, looks it up on
    // gitlab.com, and reports an unrelated project's default branch as verified.
    for (const url of [
      "https://github.com/acme/storefront",
      "https://bitbucket.org/acme/storefront",
      "https://dev.azure.com/acme/Storefront/_git/storefront",
      "https://acme.visualstudio.com/Storefront/_git/storefront",
      "git@github.com:acme/storefront.git",
    ]) {
      expect(gitlabProvider.parse(url)).toBeNull();
    }
  });

  it("rejects a single-segment path, which cannot be a project", () => {
    expect(gitlabProvider.parse("https://gitlab.com/acme")).toBeNull();
  });
});

describe("bitbucket.parse", () => {
  it("reads the workspace past the userinfo Bitbucket embeds in clone URLs", () => {
    expect(bitbucketProvider.parse("https://acme@bitbucket.org/acme/storefront.git")).toMatchObject(
      { owner: "acme", repo: "storefront" },
    );
  });
});

describe("azure-devops.parse", () => {
  it("reads the organisation/project/repository triple", () => {
    expect(azureDevOpsProvider.parse("https://dev.azure.com/acme/Storefront/_git/store")).toMatchObject(
      { organization: "acme", project: "Storefront", repo: "store" },
    );
  });

  it("takes the organisation from the subdomain on the legacy host", () => {
    expect(
      azureDevOpsProvider.parse("https://acme.visualstudio.com/Storefront/_git/store"),
    ).toMatchObject({ organization: "acme", project: "Storefront", repo: "store" });
  });

  it("defaults the project to the repository when the URL omits it", () => {
    // dev.azure.com/{org}/_git/{repo} is what its own UI hands you for a
    // single-repo project.
    expect(azureDevOpsProvider.parse("https://dev.azure.com/acme/_git/store")).toMatchObject({
      organization: "acme",
      project: "store",
      repo: "store",
    });
  });

  it("decodes names, and survives malformed escaping instead of throwing", () => {
    expect(
      azureDevOpsProvider.parse("https://dev.azure.com/acme/My%20Project/_git/store")?.project,
    ).toBe("My Project");
    // A lone `%` passes `new URL()` untouched and would raise URIError out of a
    // function contracted to return null.
    expect(() =>
      azureDevOpsProvider.parse("https://dev.azure.com/acme/100%/_git/store"),
    ).not.toThrow();
  });

  it("rejects a URL with no `_git` segment, or one in first position", () => {
    expect(azureDevOpsProvider.parse("https://dev.azure.com/acme/Storefront")).toBeNull();
    expect(azureDevOpsProvider.parse("https://dev.azure.com/_git/store")).toBeNull();
  });
});

describe("generic.parse", () => {
  it("accepts any http(s) host and any path depth", () => {
    expect(genericProvider.parse("https://git.example.com/team/project.git")).toMatchObject({
      slug: "team/project",
      host: "git.example.com",
    });
    expect(genericProvider.parse("https://git.example.com/a/b/c/d")?.slug).toBe("a/b/c/d");
    expect(genericProvider.parse("git@git.example.com:team/project.git")?.slug).toBe("team/project");
  });

  it("rejects git remote-helper syntax, which runs a shell at clone time", () => {
    // `new URL()` accepts `ext::sh -c '…'` as a URL with protocol `ext:`.
    expect(genericProvider.parse("ext::sh -c 'id'")).toBeNull();
    expect(genericProvider.parse("file:///etc/passwd")).toBeNull();
    expect(genericProvider.parse("htps://git.example.com/a/b")).toBeNull();
  });

  it("rejects a URL with no host or no path", () => {
    expect(genericProvider.parse("https://git.example.com")).toBeNull();
    expect(genericProvider.parse("https://git.example.com/")).toBeNull();
  });

  it("has no change-request API and says so with the branch name", async () => {
    await expect(
      genericProvider.createChangeRequest({
        repoUrl: "https://git.example.com/team/project",
        identity: { slug: "team/project", host: "git.example.com" },
        credential: { username: "git", secret: SECRET },
        apiBaseUrl: null,
        baseBranch: "main",
        headBranch: "pipeline/task_1",
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow(/pipeline\/task_1/);
  });
});

describe("createRepoSchema.url", () => {
  const parse = (url: string) => createRepoSchema.safeParse({ name: "n", url }).success;

  it("rejects anything that is not an http(s) URL with a host", () => {
    // `z.url()` alone accepts all of these; the URL reaches `git clone` almost
    // verbatim, so this is the boundary that has to hold.
    expect(parse("ext::sh -c 'id'")).toBe(false);
    expect(parse("file:///etc/passwd")).toBe(false);
    expect(parse("C:/repos/project")).toBe(false);
    expect(parse("htps://git.example.com/a/b")).toBe(false);
    expect(parse("ssh://git@github.com/acme/storefront")).toBe(false);
  });

  it("accepts a normal repository URL", () => {
    expect(parse("https://github.com/acme/storefront")).toBe(true);
    expect(parse("http://git.internal:8080/team/project")).toBe(true);
  });

  it("requires a generic connection to name its own credential variable", () => {
    const base = { name: "n", url: "https://git.example.com/team/project", provider: "generic" };
    expect(createRepoSchema.safeParse(base).success).toBe(false);
    expect(createRepoSchema.safeParse({ ...base, credentialRef: "GIT_TOKEN_ACME" }).success).toBe(
      true,
    );
  });
});

describe("transports", () => {
  it("embeds the credential in the URL for every provider but Azure DevOps", () => {
    const transport = githubProvider.transport("https://github.com/acme/storefront", {
      username: "x-access-token",
      secret: SECRET,
    });
    expect(transport.kind).toBe("url");
    expect(transport.url).toContain(SECRET);
    // The URL form needs no `-c` to carry the credential, so all that is left
    // is the interactive-fallback guard every transport applies.
    expect(transport.configArgs).toEqual(["-c", "credential.helper="]);
  });

  it("percent-encodes a token containing URL-significant characters", () => {
    const transport = urlTransport("https://github.com/acme/storefront", {
      username: "x-access-token",
      secret: "pat:with@slash/and#hash",
    });
    // Assigning `password` on a URL escapes it; a raw `@` would otherwise cut
    // the authority short and git would connect to the wrong host. `URL`
    // reports the escaped form back, and git decodes it before use.
    expect(transport.url).not.toContain("@slash");
    expect(decodeURIComponent(new URL(transport.url).password)).toBe("pat:with@slash/and#hash");
  });

  it("replaces the username Bitbucket and Azure DevOps embed rather than appending", () => {
    const transport = urlTransport("https://acme@bitbucket.org/acme/storefront.git", {
      username: "x-token-auth",
      secret: SECRET,
    });
    expect(new URL(transport.url).username).toBe("x-token-auth");
  });

  it("leaves the URL clean for Azure DevOps and passes a header instead", () => {
    const transport = azureDevOpsProvider.transport(
      "https://acme@dev.azure.com/acme/Storefront/_git/store",
      { username: "", secret: SECRET },
    );
    expect(transport.kind).toBe("header");
    expect(transport.url).not.toContain(SECRET);
    const header = transport.configArgs.find((arg) =>
      arg.startsWith("http.extraHeader=Authorization: Basic "),
    );
    expect(header).toBeDefined();
    // The secret must be base64 in the header, never readable in the arg.
    expect(header).not.toContain(SECRET);
    const encoded = header!.split("Basic ")[1];
    expect(Buffer.from(encoded, "base64").toString()).toBe(`:${SECRET}`);
  });

  // Regression: a clone of a private, deleted or misspelled repository is
  // indistinguishable from one needing a login, so git asks — and a credential
  // helper such as Git Credential Manager blocks on its own dialog with nobody
  // to answer it. The request hung forever instead of failing.
  it("denies git an interactive credential fallback on every transport", () => {
    const transports = [
      githubProvider.transport("https://github.com/acme/storefront", null),
      githubProvider.transport("https://github.com/acme/storefront", {
        username: "x-access-token",
        secret: SECRET,
      }),
      urlTransport("http://git.internal/team/project", { username: "git", secret: SECRET }),
      urlTransport("not a url", null),
      azureDevOpsProvider.transport("https://dev.azure.com/acme/Storefront/_git/store", null),
      azureDevOpsProvider.transport("https://dev.azure.com/acme/Storefront/_git/store", {
        username: "",
        secret: SECRET,
      }),
    ];

    for (const transport of transports) {
      // An empty value resets the helper list rather than appending to it.
      expect(transport.configArgs).toContain("credential.helper=");
    }
  });

  it("does not attach a credential over plain http", () => {
    // Sending a token in cleartext is worse than failing to authenticate.
    const transport = urlTransport("http://git.internal/team/project", {
      username: "git",
      secret: SECRET,
    });
    expect(transport.url).not.toContain(SECRET);
  });

  it("returns the URL untouched when there is no credential", () => {
    expect(urlTransport("https://github.com/acme/storefront", null).url).toBe(
      "https://github.com/acme/storefront",
    );
  });
});

describe("manualCreateUrl", () => {
  it("never leaks a secret or an embedded username", () => {
    const links = [
      githubProvider.manualCreateUrl("https://github.com/acme/storefront", "main", "feat"),
      gitlabProvider.manualCreateUrl("https://gitlab.com/acme/platform/store", "main", "feat"),
      bitbucketProvider.manualCreateUrl("https://acme@bitbucket.org/acme/store.git", "main", "feat"),
      azureDevOpsProvider.manualCreateUrl(
        "https://acme@dev.azure.com/acme/Storefront/_git/store",
        "main",
        "feat",
      ),
      genericProvider.manualCreateUrl("https://git.example.com/team/project.git", "main", "feat"),
    ];
    for (const link of links) {
      expect(link).not.toContain("@");
      expect(link.startsWith("https://")).toBe(true);
    }
  });

  it("escapes branch names that contain slashes", () => {
    const link = githubProvider.manualCreateUrl(
      "https://github.com/acme/storefront",
      "main",
      "pipeline/task_1-add-thing",
    );
    expect(link).toContain("pipeline%2Ftask_1-add-thing");
  });
});

describe("webUrl", () => {
  it("strips userinfo and trailing punctuation, leaving a clean URL alone", () => {
    expect(webUrl("https://acme@bitbucket.org/acme/store.git")).toBe(
      "https://bitbucket.org/acme/store",
    );
    expect(webUrl("https://github.com/acme/store/")).toBe("https://github.com/acme/store");
    expect(webUrl("git@github.com:acme/store.git")).toBe("git@github.com:acme/store");
  });

  it("agrees with normalizeRepoUrl when there is nothing to strip", () => {
    const url = "https://github.com/acme/store";
    expect(webUrl(url)).toBe(normalizeRepoUrl(url));
  });
});

describe("redactRemote", () => {
  it("removes a credential embedded in a remote URL", () => {
    const message = redactRemote(
      `fatal: unable to access 'https://x-access-token:${SECRET}@github.com/acme/store.git/'`,
    );
    expect(message).not.toContain(SECRET);
    expect(message).toContain("https://***@github.com/acme/store.git");
  });

  it("removes a Basic header, which is how Azure DevOps failures surface", () => {
    const basic = Buffer.from(`:${SECRET}`).toString("base64");
    const message = redactRemote(`git -c http.extraHeader=Authorization: Basic ${basic} push`);
    expect(message).not.toContain(basic);
    expect(message).toContain("Authorization: Basic ***");
  });
});

describe("credential references", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts a shell-style variable name", () => {
    expect(validateCredentialRef("BITBUCKET_TOKEN_ACME").ok).toBe(true);
    expect(validateCredentialRef("GH2").ok).toBe(true);
  });

  it("rejects malformed names, which would not be readable anyway", () => {
    for (const ref of ["lowercase", "WITH-DASH", "WITH SPACE", "9LEADING", "", "A.B"]) {
      const result = validateCredentialRef(ref);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toBe("malformed");
    }
  });

  it("rejects variables the pipeline reserves", () => {
    // Without this the field is an arbitrary-environment-variable read
    // primitive: point a connection at ANTHROPIC_API_KEY and the value is
    // handed to a remote git server on the next push.
    for (const ref of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "PATH", "DATABASE_URL"]) {
      const result = validateCredentialRef(ref);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toBe("reserved");
    }
  });

  it("falls back to the provider's conventional variable", () => {
    process.env.GITHUB_TOKEN = SECRET;
    const source = credentialSource({
      provider: githubProvider,
      credentialRef: null,
      credentialUsername: null,
    });
    expect(source).toEqual({ variable: "GITHUB_TOKEN", present: true });
  });

  it("prefers an explicit reference over the convention", () => {
    process.env.GITHUB_TOKEN = "conventional";
    process.env.GITHUB_TOKEN_ACME = SECRET;
    const credential = resolveCredential({
      provider: githubProvider,
      credentialRef: "GITHUB_TOKEN_ACME",
      credentialUsername: null,
    });
    expect(credential?.secret).toBe(SECRET);
  });

  it("uses the provider username unless the connection overrides it", () => {
    process.env.BITBUCKET_TOKEN = SECRET;
    const target = {
      provider: bitbucketProvider,
      credentialRef: null,
      credentialUsername: null,
    };
    expect(resolveCredential(target)?.username).toBe("x-token-auth");
    // App passwords authenticate as an account and need its real username.
    expect(resolveCredential({ ...target, credentialUsername: "leonan" })?.username).toBe("leonan");
  });

  it("treats a blank variable as unset rather than as an empty secret", () => {
    process.env.GITHUB_TOKEN = "   ";
    const target = { provider: githubProvider, credentialRef: null, credentialUsername: null };
    expect(credentialSource(target).present).toBe(false);
    expect(resolveCredential(target)).toBeNull();
    expect(() => requireCredential(target)).toThrow(MissingCredentialError);
  });

  it("names the variable a user has to set when it is missing", () => {
    delete process.env.GITLAB_TOKEN_ACME;
    expect(() =>
      requireCredential({
        provider: gitlabProvider,
        credentialRef: "GITLAB_TOKEN_ACME",
        credentialUsername: null,
      }),
    ).toThrow(/GITLAB_TOKEN_ACME/);
  });

  it("lists configured variables once each, ignoring connections with none", () => {
    expect(configuredCredentialVariables(["A_TOKEN", null, "A_TOKEN", "", "B_TOKEN"])).toEqual([
      "A_TOKEN",
      "B_TOKEN",
    ]);
  });
});

describe("provider contract", () => {
  it("gives every provider the metadata the UI reads", () => {
    for (const provider of PROVIDERS) {
      expect(provider.displayName).not.toBe("");
      expect(provider.changeRequestNoun).not.toBe("");
      expect(provider.exampleUrl.startsWith("https://")).toBe(true);
      expect(provider.defaultCredentialEnvVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      // The conventional variable must itself be a legal reference, or a user
      // could not reproduce the default with an explicit one.
      expect(validateCredentialRef(provider.defaultCredentialEnvVar).ok).toBe(true);
    }
  });

  it("parses its own example URL", () => {
    for (const provider of PROVIDERS) {
      expect(provider.parse(provider.exampleUrl), provider.id).not.toBeNull();
    }
  });

  it("refuses to verify a connection with no credential", async () => {
    for (const provider of PROVIDERS) {
      const identity = provider.parse(provider.exampleUrl);
      const check = await provider.verifyAccess({
        repoUrl: provider.exampleUrl,
        identity: identity ?? { slug: "a/b", host: "example.com" },
        credential: null,
        apiBaseUrl: null,
      });
      expect(check.ok, provider.id).toBe(false);
    }
  });
});
