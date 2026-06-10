export function ComingSoon({ area }: { area: string }) {
  return (
    <div className="py-16">
      <div className="font-display text-4xl text-ink-100 mb-3">{area}</div>
      <p className="text-ink-300">Em construção — esta área será habilitada pelo próximo agente.</p>
    </div>
  )
}
