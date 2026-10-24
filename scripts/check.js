import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
for (const dir of ['src', 'test', 'scripts']) for (const file of readdirSync(dir)) {
 if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', join(dir,file)], {stdio:'inherit'})
 if (file.endsWith('.sh')) execFileSync('bash', ['-n',join(dir,file)], {stdio:'inherit'})
 if (file.endsWith('.py')) execFileSync('python3', ['-c','import ast,sys; ast.parse(open(sys.argv[1]).read())',join(dir,file)], {stdio:'inherit'})
}
console.log('JavaScript and shell syntax checks passed')
