import nextPlugin from 'eslint-config-next'

// eslint-config-next v16 exports a ready-made flat config array:
// [core rules, typescript rules, ignores].
const config = [
  ...nextPlugin,
  {
    ignores: ['.build/**', '.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
]

export default config
