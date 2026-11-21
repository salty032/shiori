import { describe, expect, it } from 'vitest'
import { ja } from './ja'
import { en } from './en'

// 差し込み（{count}・{percent} など）が日英で揃っているか。キーの揃いは型が見ているが、
// 文の中の差し込みは見ていない。片方だけ書き忘れると、その言語の画面に数字が抜けた文が出るか、
// 渡していない名前が「{name}」のまま出る。
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
}

describe('文言の差し込み', () => {
  it('どのキーも、日本語と英語で差し込みの名前が同じ', () => {
    const mismatched = (Object.keys(ja) as (keyof typeof ja)[])
      .filter((key) => placeholders(ja[key]).join(',') !== placeholders(en[key]).join(','))
      .map((key) => `${key}: ja {${placeholders(ja[key]).join(', ')}} / en {${placeholders(en[key]).join(', ')}}`)
    expect(mismatched).toEqual([])
  })
})
