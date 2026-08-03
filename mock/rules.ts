/**
 * Declarative rules for the bundled mock servers, for tests that need a
 * hand-written prediction source.
 *
 * These were vetted built-in profiles until profiles were removed: they were
 * per-server code that rotted silently (GitHub's hosted server renamed its
 * tools and the bundled profile simply stopped matching, with nothing
 * failing), and measurement showed the generic learner delivered the bulk of
 * the benefit without any of them.
 *
 * What survives is the config `rules` DSL, so these fixtures are the same
 * predictions expressed the way a user would express them. That makes the
 * scenario tests a better check than before: they now exercise the mechanism
 * that actually ships to people, rather than a bundled table nobody had.
 *
 * Two of the old rules are NOT reproduced, because the DSL deliberately has
 * no computation: `fs:list→read` joined a directory and an entry name into a
 * path, and `fs:read→dir` took a parent directory. Selectors copy values,
 * they do not compute them.
 */

export const GITHUB_ALLOW = [
  'get_issue',
  'get_issue_comments',
  'list_issues',
  'list_pull_requests',
  'get_pull_request',
  'get_pull_request_diff',
  'get_file_contents',
];

export const GITHUB_RULES = [
  {
    trigger: 'get_issue',
    predict: [
      {
        tool: 'get_issue_comments',
        args: { owner: '$args.owner', repo: '$args.repo', issue_number: '$args.issue_number' },
        confidence: 0.8,
      },
      {
        tool: 'list_pull_requests',
        args: { owner: '$args.owner', repo: '$args.repo', state: 'open' },
        confidence: 0.6,
      },
    ],
  },
  {
    trigger: 'list_pull_requests',
    predict: [
      {
        tool: 'get_pull_request',
        args: { owner: '$args.owner', repo: '$args.repo', pull_number: '$item.number' },
        forEach: '$parsed',
        limit: 2,
        confidence: 0.5,
      },
    ],
  },
  {
    trigger: 'get_pull_request',
    predict: [
      {
        tool: 'get_pull_request_diff',
        args: { owner: '$args.owner', repo: '$args.repo', pull_number: '$args.pull_number' },
        confidence: 0.7,
      },
    ],
  },
  {
    trigger: 'list_issues',
    predict: [
      {
        tool: 'get_issue',
        args: { owner: '$args.owner', repo: '$args.repo', issue_number: '$item.number' },
        forEach: '$parsed',
        limit: 2,
        confidence: 0.45,
      },
    ],
  },
];

export const FILESYSTEM_ALLOW = [
  'read_file',
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
];

export const FILESYSTEM_RULES = [
  {
    // Search hits, then reading the top matches. `search_files` returns bare
    // path strings, so the element itself is the argument.
    trigger: 'search_files',
    predict: [
      {
        tool: 'read_text_file',
        args: { path: '$item' },
        forEach: '$parsed',
        limit: 2,
        confidence: 0.5,
      },
    ],
  },
];

export const SLACK_ALLOW = [
  'slack_list_channels',
  'slack_get_channel_history',
  'slack_get_thread_replies',
  'slack_get_users',
  'slack_get_user_profile',
];

export const SLACK_RULES = [
  {
    trigger: 'slack_list_channels',
    predict: [
      {
        tool: 'slack_get_channel_history',
        args: { channel_id: '$item.id' },
        forEach: '$parsed.channels',
        limit: 2,
        confidence: 0.5,
      },
    ],
  },
  {
    trigger: 'slack_get_users',
    predict: [
      {
        tool: 'slack_get_user_profile',
        args: { user_id: '$item.id' },
        forEach: '$parsed.members',
        limit: 2,
        confidence: 0.4,
      },
    ],
  },
];
