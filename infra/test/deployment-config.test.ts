import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG_PATH,
  type DeploymentConfig,
  loadDeploymentConfig,
  parseDeploymentConfig,
  resolveConfigPath,
  tokenBrokerRepos,
} from '../lib/deployment-config';
import { ACCOUNT, fixture } from './helpers';

/** The error message for `raw`, or a failure if it parses. */
function problems(raw: unknown, env: { CDK_DEFAULT_ACCOUNT?: string } = {}): string {
  try {
    parseDeploymentConfig(raw, env);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the configuration to be rejected');
}

function withChange(change: (raw: any) => void): any {
  const raw = fixture();
  change(raw);
  return raw;
}

describe('defaults', () => {
  test('a minimal configuration gets the product defaults', () => {
    const config = parseDeploymentConfig(fixture());
    expect(config.aws.bootstrapQualifier).toBe('hnb659fds');
    expect(config.models).toEqual({
      reviewer: { primary: 'us.anthropic.claude-opus-5-5', fallback: 'openai.gpt-6.1-sol', effort: 'high' },
      curator: { primary: 'us.anthropic.claude-opus-5-5', fallback: 'openai.gpt-6.1-sol', effort: 'medium', fallbackEffort: 'high' },
      summarizer: { primary: 'us.anthropic.claude-haiku-5-5', fallback: 'openai.gpt-6.1-sol' },
      safetyGate: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      profileRegions: ['us-east-1', 'us-east-2', 'us-west-2'],
      mantleRegion: 'us-east-1',
      mantleGrantRegions: ['us-east-1'],
      extraGrants: [],
    });
    expect(config.agents).toEqual({
      'valkey-review': { maxIterations: 150, maxTokens: 32768, allowBuild: true, allowWrite: true },
      'valkey-glide-review': { maxIterations: 150, maxTokens: 32768, allowBuild: true, allowWrite: true },
      curator: { maxIterations: 40, maxTokens: 16384, graduationThreshold: 4 },
    });
    expect(config.upstreamRepos).toEqual({ 'valkey-review': 'valkey-io/valkey', 'valkey-glide-review': 'valkey-io/valkey-glide' });
    expect(config.decay).toEqual({ halfLifeDays: 30, floor: 0.05 });
    expect(config.dailyReviewBudget).toBe(40);
    expect(config.github.installationId).toBeUndefined();
    expect(config.github.knownBotLogins).toBeUndefined();
    expect(config.routes[0]).toEqual({
      id: 'valkey-review', reviewer: 'valkey-review', repo: 'example-org/valkey',
      threadReplyReview: false, skipDrafts: false, mentionOnly: false, authorAllowlist: [],
    });
  });

  test('the committed example parses and holds placeholders only', () => {
    const file = path.join(__dirname, '..', 'deploy.config.example.json');
    const config = parseDeploymentConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(config.aws.account).toBe(ACCOUNT);
    expect(config.github.appId).toBe('123456');
    expect(config.github.botLogin).toBe('your-app-slug[bot]');
    expect(config.routes.length).toBeGreaterThan(0);
    for (const route of config.routes) expect(route.repo.startsWith('your-org/')).toBe(true);
  });

  test("each reviewer's token broker covers exactly that reviewer's review routes", () => {
    const config = parseDeploymentConfig(fixture());
    expect(tokenBrokerRepos(config, 'valkey-review')).toEqual(['example-org/valkey', 'upstream-org/valkey']);
    expect(tokenBrokerRepos(config, 'valkey-glide-review')).toEqual(['example-org/valkey-glide']);
  });

  test('a repository named . or .. is refused, as the decay job and the curator refuse it', () => {
    const message = problems(withChange((raw) => {
      raw.upstreamRepos = { 'valkey-review': 'valkey-io/..', 'valkey-glide-review': 'valkey-io/.' };
      raw.routes[0].repo = 'example-org/..';
    }));
    expect(message).toContain('upstreamRepos.valkey-review must be owner/name');
    expect(message).toContain('upstreamRepos.valkey-glide-review must be owner/name');
    expect(message).toContain('routes[0].repo must be owner/name');
    expect(parseDeploymentConfig(withChange((raw) => { raw.upstreamRepos = { 'valkey-review': 'valkey-io/.valkey..x' }; }))
      .upstreamRepos['valkey-review']).toBe('valkey-io/.valkey..x');
  });

  test('an empty upstream repository means "use the pull request repository"', () => {
    const config = parseDeploymentConfig(withChange((raw) => { raw.upstreamRepos = { 'valkey-review': '' }; }));
    expect(config.upstreamRepos['valkey-review']).toBe('');
    expect(config.upstreamRepos['valkey-glide-review']).toBe('valkey-io/valkey-glide');
  });
});

describe('aws', () => {
  test('account must be 12 digits and region region-shaped', () => {
    const message = problems(withChange((raw) => { raw.aws = { account: '1234', region: 'uswest2' }; }));
    expect(message).toContain('aws.account must be a 12-digit AWS account ID');
    expect(message).toContain('aws.region must be an AWS region');
  });

  test('account must match the credentials the CDK CLI is using', () => {
    expect(problems(fixture(), { CDK_DEFAULT_ACCOUNT: '222222222222' }))
      .toContain('aws.account is 111111111111 but the current AWS credentials are for account 222222222222');
    expect(() => parseDeploymentConfig(fixture(), { CDK_DEFAULT_ACCOUNT: ACCOUNT })).not.toThrow();
  });

  test('bootstrap qualifier is validated', () => {
    expect(problems(withChange((raw) => { raw.aws.bootstrapQualifier = 'Not_Valid!'; }))).toContain('aws.bootstrapQualifier');
  });

  test('every problem is reported at once', () => {
    const message = problems({});
    for (const key of ['aws is required', 'github is required', 'skillsRegistries is required', 'routes is required']) {
      expect(message).toContain(key);
    }
  });

  test('unknown keys are rejected so typos do not pass silently', () => {
    expect(problems(withChange((raw) => { raw.dailyReviewBudgett = 3; }))).toContain('config.dailyReviewBudgett is not a known setting');
    expect(problems(withChange((raw) => { raw.models = { reviewer: { primay: 'x.y' } }; })))
      .toContain('models.reviewer.primay is not a known setting');
  });
});

describe('github', () => {
  test('app and installation ids are digits', () => {
    const message = problems(withChange((raw) => { raw.github.appId = 'abc'; raw.github.installationId = '12x'; }));
    expect(message).toContain('github.appId must be the numeric GitHub App ID');
    expect(message).toContain('github.installationId must be a numeric installation ID');
  });

  test('bot login ends with [bot]', () => {
    expect(problems(withChange((raw) => { raw.github.botLogin = 'example-reviewer'; }))).toContain('github.botLogin must end with [bot]');
  });

  test('secret name is required', () => {
    expect(problems(withChange((raw) => { delete raw.github.appSecretName; }))).toContain('github.appSecretName is required');
  });

  test('known bot logins must be logins', () => {
    expect(problems(withChange((raw) => { raw.github.knownBotLogins = ['ok-bot[bot]', 'not a login']; })))
      .toContain('github.knownBotLogins[1]');
  });
});

describe('skillsRegistries', () => {
  const arn = (partition: string, region: string, account: string) =>
    `arn:${partition}:agent-registry:${region}:${account}:registry/abc_123`;

  test('accepts IDs and ARNs in the deployment partition, region and account', () => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.skillsRegistries.curator = arn('aws', 'us-west-2', ACCOUNT);
    }));
    expect(config.skillsRegistries.curator).toBe(arn('aws', 'us-west-2', ACCOUNT));
  });

  test.each([
    ['another account', arn('aws', 'us-west-2', '222222222222')],
    ['another region', arn('aws', 'us-east-1', ACCOUNT)],
    ['another partition', arn('aws-cn', 'us-west-2', ACCOUNT)],
  ])('rejects an ARN in %s', (_label, value) => {
    expect(problems(withChange((raw) => { raw.skillsRegistries['valkey-review'] = value; })))
      .toContain('skillsRegistries.valkey-review must be in partition aws, region us-west-2 and account 111111111111');
  });

  test('rejects values that are neither IDs nor agent-registry ARNs', () => {
    for (const value of ['has spaces', `arn:aws:bedrock-agentcore:us-west-2:${ACCOUNT}:registry/abc`, '']) {
      expect(problems(withChange((raw) => { raw.skillsRegistries['valkey-glide-review'] = value; })))
        .toContain('skillsRegistries.valkey-glide-review must be a registry ID');
    }
  });

  test('every registry is required', () => {
    expect(problems(withChange((raw) => { delete raw.skillsRegistries.curator; }))).toContain('skillsRegistries.curator is required');
  });
});

describe('routes', () => {
  test('at least one route', () => {
    expect(problems(withChange((raw) => { raw.routes = []; }))).toContain('routes must list at least one route');
  });

  test('route ids are unique, also after construct-id normalization', () => {
    expect(problems(withChange((raw) => { raw.routes[1].id = 'valkey-review'; }))).toContain('routes[1].id');
    expect(problems(withChange((raw) => { raw.routes[1].id = 'valkeyreview'; })))
      .toContain('routes[1].id "valkeyreview" collides with route "valkey-review"');
  });

  test('a repository has one route, across review and curator-only routes, ignoring case', () => {
    expect(problems(withChange((raw) => { raw.routes[1].repo = 'Example-Org/Valkey'; })))
      .toContain('routes[1].repo repeats repository Example-Org/Valkey');
    expect(problems(withChange((raw) => { raw.curatorOnlyRoutes[0].repo = 'example-org/valkey'; })))
      .toContain('curatorOnlyRoutes[0].repo repeats repository example-org/valkey');
  });

  test('repo is owner/name and reviewer is a known reviewer', () => {
    const message = problems(withChange((raw) => {
      raw.routes[0].repo = 'just-a-name';
      raw.routes[1].reviewer = 'valkey-other-review';
    }));
    expect(message).toContain('routes[0].repo must be owner/name');
    expect(message).toContain('routes[1].reviewer must be one of valkey-review, valkey-glide-review');
  });

  test('flags are booleans and the allowlist holds logins', () => {
    const message = problems(withChange((raw) => {
      raw.routes[0].skipDrafts = 'yes';
      raw.routes[0].authorAllowlist = ['bad login'];
    }));
    expect(message).toContain('routes[0].skipDrafts must be true or false');
    expect(message).toContain('routes[0].authorAllowlist[0]');
  });
});

describe('models', () => {
  test('effort is one of the supported levels', () => {
    expect(problems(withChange((raw) => { raw.models = { reviewer: { effort: 'extreme' } }; })))
      .toContain('models.reviewer.effort must be one of low, medium, high, xhigh, max');
  });

  test('us.* profiles need a us-* region and us-* profile regions', () => {
    expect(problems(withChange((raw) => { raw.aws.region = 'eu-west-1'; })))
      .toContain('models.reviewer.primary is a us.* inference profile, which needs aws.region to be a us-* region outside GovCloud (got eu-west-1)');
    expect(problems(withChange((raw) => { raw.models = { profileRegions: ['us-east-1', 'eu-west-1'] }; })))
      .toContain('models.profileRegions contains eu-west-1');
  });

  /** Every Bedrock model setting on `profile`, with the openai.* fallbacks left as they are. */
  const allOn = (profile: string, profileRegions: string[]) => ({
    reviewer: { primary: profile },
    curator: { primary: profile },
    summarizer: { primary: profile },
    safetyGate: profile,
    profileRegions,
  });

  test.each([
    ['us-gov', 'us-gov-west-1', ['us-gov-west-1', 'us-gov-east-1']],
    ['eu', 'eu-central-1', ['eu-central-1', 'eu-west-1']],
    ['apac', 'ap-southeast-1', ['ap-southeast-1', 'ap-northeast-1']],
    ['jp', 'ap-northeast-1', ['ap-northeast-1', 'ap-northeast-3']],
    ['au', 'ap-southeast-2', ['ap-southeast-2', 'ap-southeast-4']],
    ['in', 'ap-south-1', ['ap-south-1', 'ap-south-2']],
    ['ca', 'ca-central-1', ['ca-central-1', 'ca-west-1']],
  ])('%s.* profiles are accepted in their own geography', (group, region, profileRegions) => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.aws.region = region;
      raw.models = allOn(`${group}.anthropic.claude-haiku-5-5`, profileRegions);
    }));
    expect(config.models.safetyGate).toBe(`${group}.anthropic.claude-haiku-5-5`);
  });

  test.each([
    ['us', 'us-gov-west-1', 'a us-* region outside GovCloud'],
    ['us-gov', 'us-east-1', 'a us-gov-* region'],
    ['jp', 'eu-west-1', 'an ap-* region'],
    ['au', 'us-west-2', 'an ap-* region'],
    ['ca', 'us-east-1', 'a ca-* region'],
  ])('%s.* profiles are rejected from %s', (group, region, expected) => {
    const message = problems(withChange((raw) => {
      raw.aws.region = region;
      raw.models = allOn(`${group}.anthropic.claude-haiku-5-5`, [region]);
    }));
    expect(message).toContain(`models.safetyGate is a ${group}.* inference profile, which needs aws.region to be ${expected} (got ${region})`);
    expect(message).toContain(`models.profileRegions contains ${region}, which ${group}.* profile`);
  });

  test('profile regions must suit every profile group in use', () => {
    const message = problems(withChange((raw) => {
      raw.aws.region = 'ap-northeast-1';
      raw.models = { ...allOn('apac.anthropic.claude-haiku-5-5', ['ap-northeast-1', 'eu-west-1']), extraGrants: ['jp.anthropic.claude-haiku-5-5'] };
    }));
    expect(message).toContain('models.profileRegions contains eu-west-1, which apac.* profile');
    expect(message).toContain('models.profileRegions contains eu-west-1, which jp.* profile');
  });

  test('a first token that is not a region group is a model provider', () => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.aws.region = 'eu-west-1';
      raw.models = { ...allOn('anthropic.claude-haiku-4-5-20251001-v1:0', []), extraGrants: ['constructor.not-a-group'] };
    }));
    expect(config.models.profileRegions).toEqual([]);
  });

  test('a geographic profile needs profile regions', () => {
    expect(problems(withChange((raw) => { raw.models = { profileRegions: [] }; })))
      .toContain('models.profileRegions must list the regions');
  });

  test('global profiles are rejected', () => {
    expect(problems(withChange((raw) => { raw.models = { summarizer: { primary: 'global.anthropic.claude-haiku-5-5' } }; })))
      .toContain('models.summarizer.primary uses a global inference profile');
  });

  test('openai.* models need a Mantle region that is also granted', () => {
    expect(problems(withChange((raw) => { raw.models = { mantleRegion: '' }; })))
      .toContain('models.mantleRegion is required because models.reviewer.fallback');
    expect(problems(withChange((raw) => { raw.models = { mantleRegion: 'us-east-2', mantleGrantRegions: ['us-east-1'] }; })))
      .toContain('models.mantleGrantRegions must include models.mantleRegion (us-east-2)');
  });

  test('without openai.* models the Mantle region may be empty', () => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.models = {
        reviewer: { fallback: 'us.anthropic.claude-sonnet-5-5' },
        curator: { fallback: 'us.anthropic.claude-sonnet-5-5' },
        summarizer: { fallback: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
        mantleRegion: '',
      };
    }));
    expect(config.models.mantleRegion).toBe('');
    expect(config.models.mantleGrantRegions).toEqual([]);
  });

  test('the safety gate must be a Bedrock model', () => {
    expect(problems(withChange((raw) => { raw.models = { safetyGate: 'openai.gpt-6.1-sol' }; })))
      .toContain('models.safetyGate must be a Bedrock model');
  });

  test('model ids are shaped like Bedrock ids', () => {
    expect(problems(withChange((raw) => { raw.models = { extraGrants: ['no-dot'] }; }))).toContain('models.extraGrants[0]');
  });
});

describe('numbers', () => {
  test('agent limits, decay and budget are range-checked', () => {
    const message = problems(withChange((raw) => {
      raw.agents = { 'valkey-review': { maxIterations: 0 }, curator: { graduationThreshold: 2.5 } };
      raw.decay = { halfLifeDays: 0, floor: 1 };
      raw.dailyReviewBudget = -1;
    }));
    expect(message).toContain('agents.valkey-review.maxIterations must be an integer >= 1');
    expect(message).toContain('agents.curator.graduationThreshold must be an integer');
    expect(message).toContain('decay.halfLifeDays must be a number > 0');
    expect(message).toContain('decay.floor must be a number > 0 and < 1');
    expect(message).toContain('dailyReviewBudget must be an integer >= 0');
  });

  // The same ranges the agents enforce when they boot.
  const agentLimits: [string, number, number][] = [
    ['valkey-review.maxIterations', 1, 500],
    ['valkey-glide-review.maxIterations', 1, 500],
    ['curator.maxIterations', 1, 500],
    ['valkey-review.maxTokens', 1024, 200_000],
    ['valkey-glide-review.maxTokens', 1024, 200_000],
    ['curator.maxTokens', 1024, 200_000],
    ['curator.graduationThreshold', 2, 100],
  ];
  const withAgentSetting = (key: string, value: number) => withChange((raw) => {
    const [agent, setting] = key.split('.') as [string, string];
    raw.agents = { [agent]: { [setting]: value } };
  });
  const agentSetting = (config: DeploymentConfig, key: string): unknown => {
    const [agent, setting] = key.split('.') as [string, string];
    return (config.agents as any)[agent][setting];
  };

  test.each(agentLimits)('agents.%s accepts %d and %d', (key, min, max) => {
    expect(agentSetting(parseDeploymentConfig(withAgentSetting(key, min)), key)).toBe(min);
    expect(agentSetting(parseDeploymentConfig(withAgentSetting(key, max)), key)).toBe(max);
  });

  test.each(agentLimits)('agents.%s rejects values just outside %d to %d', (key, min, max) => {
    const expected = `agents.${key} must be an integer >= ${min} and <= ${max}`;
    expect(problems(withAgentSetting(key, min - 1))).toContain(`${expected} (got ${min - 1})`);
    expect(problems(withAgentSetting(key, max + 1))).toContain(`${expected} (got ${max + 1})`);
  });

  test('a zero budget is allowed and pauses automatic reviews', () => {
    expect(parseDeploymentConfig(withChange((raw) => { raw.dailyReviewBudget = 0; })).dailyReviewBudget).toBe(0);
  });
});

describe('loading', () => {
  test('-c config wins over VALKEY_REVIEWER_CONFIG, which wins over the default file', () => {
    expect(resolveConfigPath('a.json', { VALKEY_REVIEWER_CONFIG: 'b.json' })).toBe(path.resolve('a.json'));
    expect(resolveConfigPath(undefined, { VALKEY_REVIEWER_CONFIG: 'b.json' })).toBe(path.resolve('b.json'));
    expect(resolveConfigPath(undefined, {})).toBe(DEFAULT_CONFIG_PATH);
    expect(DEFAULT_CONFIG_PATH).toBe(path.join(__dirname, '..', 'deploy.config.json'));
  });

  test('reads and validates the file, naming it in errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-config-'));
    try {
      const good = path.join(dir, 'good.json');
      fs.writeFileSync(good, JSON.stringify(fixture()));
      expect(loadDeploymentConfig(good, {}).aws.account).toBe(ACCOUNT);

      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, '{ not json');
      expect(() => loadDeploymentConfig(bad, {})).toThrow(`${bad} is not valid JSON`);

      expect(() => loadDeploymentConfig(good, { CDK_DEFAULT_ACCOUNT: '222222222222' })).toThrow(good);
      expect(() => loadDeploymentConfig(path.join(dir, 'missing.json'), {})).toThrow('Copy infra/deploy.config.example.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
