export default {
  extends: ['@commitlint/config-conventional'],
  defaultIgnores: process.env.COMMITLINT_PR_TITLE !== 'true',
  rules: {
    'header-max-length': [2, 'always', 72],
  },
};
