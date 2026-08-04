import changelogRaw from '../../CHANGELOG.md?raw'
import { Card } from '../components/ui'

/** v1: reads the static CHANGELOG.md bundled at build time. If we later need to
 * publish a release note without a redeploy, swap this for a `release_notes`
 * table -- tracked as an open decision in CLAUDE.md section 7. */
export function Changelog() {
  const sections = parseChangelog(changelogRaw)

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">Novedades</h1>
      {sections.map((section) => (
        <Card key={section.heading}>
          <h2 className="mb-2 font-semibold text-brand-700">{section.heading}</h2>
          <div className="space-y-1 text-sm text-brand-600 whitespace-pre-wrap">{section.body}</div>
        </Card>
      ))}
    </div>
  )
}

function parseChangelog(markdown: string): { heading: string; body: string }[] {
  const lines = markdown.split('\n')
  const sections: { heading: string; body: string }[] = []
  let current: { heading: string; body: string[] } | null = null

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() })
      current = { heading: line.replace(/^##\s*/, ''), body: [] }
    } else if (current && line.trim() && !line.startsWith('# ')) {
      current.body.push(line.replace(/^###\s*/, '').replace(/^-\s*/, '• '))
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() })
  return sections
}
