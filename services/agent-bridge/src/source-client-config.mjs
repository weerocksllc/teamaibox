const INTERNAL_GATEWAYS = Object.freeze({
  pip: Object.freeze({ path: "/pip/simple/", url: "http://source-gateway:8080/pip/simple/" }),
  npm: Object.freeze({ path: "/npm/registry/", url: "http://source-gateway:8080/npm/registry/" }),
  apt: Object.freeze({ path: "/apt", url: "http://source-gateway:8080/apt" }),
});

const FORBIDDEN_CLIENT_TEXT = /(?:authorization|proxy-authorization|_auth(?:token)?|_password|username\s*=|extra-index-url|https?:\/\/[^\s/@]+:[^\s/@]+@)/i;

function validateGateway(kind, value) {
  if (typeof value !== "string") throw new TypeError(`Agent sandbox ${kind} gateway is invalid`);
  const expected = INTERNAL_GATEWAYS[kind];
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "source-gateway" || url.port !== "8080"
    || url.pathname !== expected.path || url.search || url.hash || url.username || url.password
    || value !== expected.url) {
    throw new TypeError(`Agent sandbox ${kind} gateway must use the internal source gateway`);
  }
  return value;
}

function ensureCredentialFree(config) {
  const contents = Object.values(config).filter((value) => typeof value === "string").join("\n");
  if (FORBIDDEN_CLIENT_TEXT.test(contents)) {
    throw new TypeError("Agent sandbox source configuration contains credential or upstream-source fields");
  }
}

export function generateSourceClientConfig(gateways) {
  const pip = validateGateway("pip", gateways?.pip);
  const npm = validateGateway("npm", gateways?.npm);
  const apt = validateGateway("apt", gateways?.apt);
  const config = {
    schemaVersion: 1,
    pipConf: `[global]\nindex-url = ${pip}\ntrusted-host = source-gateway\ndisable-pip-version-check = true\nno-input = true\n`,
    npmrc: `registry=${npm}\nalways-auth=false\naudit=false\nupdate-notifier=false\nfund=false\n`,
    aptConf: "Dir::Etc::sourcelist \"/run/teamaibox/source-config/apt/sources.list\";\nDir::Etc::sourceparts \"-\";\nAPT::Architecture \"arm64\";\nAPT::Architectures \"arm64\";\nAPT::Sandbox::User \"65532\";\nAcquire::Languages \"none\";\nAcquire::Retries \"2\";\nAcquire::http::Timeout \"120\";\nAcquire::http::Pipeline-Depth \"0\";\nAcquire::AllowInsecureRepositories \"false\";\nAcquire::AllowDowngradeToInsecureRepositories \"false\";\n",
    aptSources: `deb [arch=arm64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] ${apt} bookworm main\n`,
  };
  ensureCredentialFree(config);
  return Object.freeze(config);
}

export function sourceClientEnvironment(gateways) {
  const config = generateSourceClientConfig(gateways);
  void config;
  return Object.freeze({
    TEAMAIBOX_PIP_INDEX_URL: gateways.pip,
    TEAMAIBOX_NPM_REGISTRY_URL: gateways.npm,
    TEAMAIBOX_APT_PROXY_URL: gateways.apt,
    PIP_CONFIG_FILE: "/run/teamaibox/source-config/pip.conf",
    PIP_INDEX_URL: gateways.pip,
    PIP_EXTRA_INDEX_URL: "",
    PIP_TRUSTED_HOST: "source-gateway",
    NPM_CONFIG_USERCONFIG: "/run/teamaibox/source-config/npmrc",
    NPM_CONFIG_REGISTRY: gateways.npm,
    APT_CONFIG: "/run/teamaibox/source-config/apt/apt.conf",
  });
}

export const INTERNAL_SOURCE_GATEWAYS = Object.freeze(Object.fromEntries(
  Object.entries(INTERNAL_GATEWAYS).map(([kind, declaration]) => [kind, declaration.url]),
));
