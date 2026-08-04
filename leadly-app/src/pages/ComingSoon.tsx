import { Card } from '../components/ui'

export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">{title}</h1>
      <Card>
        <p className="text-sm text-brand-500">Este módulo se implementa en la siguiente etapa del roadmap. Ver CLAUDE.md / backlog.</p>
      </Card>
    </div>
  )
}
