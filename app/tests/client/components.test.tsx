// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge, statusTone, guardrailTone, riskTone } from '~/components/ui/Badge'
import { Card, CardHeader, CardBody } from '~/components/ui/Card'
import { Button } from '~/components/ui/Button'
import { EmptyState } from '~/components/ui/EmptyState'
import { Sparkline } from '~/components/ui/Sparkline'
import { fmtBrl, fmtPct } from '~/lib/formatters'

describe('UI components', () => {
  it('Badge renders children', () => {
    render(<Badge tone="sage">hello</Badge>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('Card+Header+Body compose', () => {
    render(
      <Card>
        <CardHeader>H</CardHeader>
        <CardBody>B</CardBody>
      </Card>,
    )
    expect(screen.getByText('H')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
  })

  it('Button click handler fires', () => {
    let n = 0
    render(<Button onClick={() => n++}>click</Button>)
    screen.getByText('click').click()
    expect(n).toBe(1)
  })

  it('EmptyState renders title + description', () => {
    render(<EmptyState title="Nada aqui" description="vazio" />)
    expect(screen.getByText('Nada aqui')).toBeInTheDocument()
    expect(screen.getByText('vazio')).toBeInTheDocument()
  })

  it('Sparkline returns nothing for <2 values', () => {
    const { container } = render(<Sparkline values={[1]} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('Sparkline renders polyline for 3+ values', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />)
    expect(container.querySelector('polyline')).not.toBeNull()
  })

  describe('status mappers', () => {
    it('statusTone', () => {
      expect(statusTone('approved')).toBe('sage')
      expect(statusTone('failed')).toBe('coral')
      expect(statusTone('pending')).toBe('neutral')
    })
    it('guardrailTone', () => {
      expect(guardrailTone('ok')).toBe('sage')
      expect(guardrailTone('blocked')).toBe('coral')
    })
    it('riskTone', () => {
      expect(riskTone('high')).toBe('coral')
      expect(riskTone(null)).toBe('neutral')
    })
  })

  describe('formatters', () => {
    it('fmtBrl', () => {
      expect(fmtBrl(1234.56)).toBe('R$ 1.234,56')
      expect(fmtBrl(null)).toBe('—')
    })
    it('fmtPct', () => {
      expect(fmtPct(0.123)).toBe('12,3%')
      expect(fmtPct(null)).toBe('—')
    })
  })
})
