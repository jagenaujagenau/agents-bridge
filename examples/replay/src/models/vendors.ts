import { siAnthropic, siDeepseek, siGoogle, siMeta, siMistralai, siMoonshotai, siQwen } from "simple-icons"

/**
 * Model names → the vendor that made the model, for display. Keyed only on the canonical
 * `usage.recorded.model` text, never on which harness ran the session: the same model can
 * run in any harness. (This is why the architecture test exempts this one file: vendor
 * names such as the one behind Anthropic's models are data here, not harness branches.)
 */

export interface Vendor {
  readonly id: string
  readonly name: string
  /** An SVG path on a 24×24 viewBox, when a logo is available; otherwise a letter badge. */
  readonly path?: string | undefined
  readonly letter: string
}

const vendor = (id: string, name: string, icon?: { readonly path: string }): Vendor => ({
  id,
  name,
  path: icon?.path,
  letter: name[0]!.toUpperCase()
})

const VENDORS: ReadonlyArray<readonly [RegExp, Vendor]> = [
  [/claude|anthropic/i, vendor("anthropic", "Anthropic", siAnthropic)],
  // No logo ships for these; they get a letter badge rather than an invented mark.
  [/^(gpt|o\d|chatgpt|openai|text-davinci)|\/gpt/i, vendor("openai", "OpenAI")],
  [/gemini|gemma|palm|google\//i, vendor("google", "Google", siGoogle)],
  [/deepseek/i, vendor("deepseek", "DeepSeek", siDeepseek)],
  [/qwen|qwq/i, vendor("qwen", "Qwen", siQwen)],
  [/glm|zai\/|z-ai|zhipu/i, vendor("zai", "Z.ai")],
  [/grok|xai\//i, vendor("xai", "xAI")],
  [/mistral|mixtral|codestral|devstral/i, vendor("mistral", "Mistral AI", siMistralai)],
  [/llama|meta\//i, vendor("meta", "Meta", siMeta)],
  [/kimi|moonshot/i, vendor("moonshot", "Moonshot AI", siMoonshotai)]
]

const UNKNOWN: Vendor = { id: "unknown", name: "Unknown vendor", letter: "?" }

export const vendorOf = (model: string): Vendor => VENDORS.find(([pattern]) => pattern.test(model))?.[1] ?? UNKNOWN

const ACRONYMS = new Set(["gpt", "glm", "qwq", "xl", "vl"])
/** Words vendors spell with inner capitals. */
const CASED: Readonly<Record<string, string>> = { deepseek: "DeepSeek" }

/**
 * A readable model name: `claude-opus-5-5` → "Claude Opus 5.5", `gpt-5.4-mini` → "GPT-5.4 Mini",
 * `google/gemma-4-e4b` → "Gemma 4 E4B". Unrecognised shapes stay as recorded.
 */
export const modelLabel = (model: string): string => {
  const name = model.slice(model.lastIndexOf("/") + 1).replace(/-\d{8}$/, "")
  // An unknown vendor's name is shown as recorded; title-casing it would invent a product name.
  if (vendorOf(model) === UNKNOWN || !/^[a-z0-9.\-]+$/i.test(name)) return model
  const parts = name.split("-")
  const out: Array<string> = []
  for (const part of parts) {
    const previous = out.at(-1)
    // Consecutive single numbers are one version: opus-5-5 → 5.5.
    if (/^\d+$/.test(part) && previous !== undefined && /^\d+(\.\d+)?$/.test(previous)) {
      out[out.length - 1] = `${previous}.${part}`
    } else if (ACRONYMS.has(part.toLowerCase())) out.push(part.toUpperCase())
    else if (CASED[part.toLowerCase()] !== undefined) out.push(CASED[part.toLowerCase()]!)
    else if (/^[a-z]\d/i.test(part) && part.length <= 4) out.push(part.toUpperCase())
    else out.push(part[0]!.toUpperCase() + part.slice(1))
  }
  // "GPT 5.4" reads as "GPT-5.4", the way the vendors write it.
  return out.join(" ").replace(/^(GPT|GLM) (\d)/, "$1-$2")
}

/** Model names that do not identify a model: placeholders some harnesses record. */
export const isRealModel = (model: string | undefined): model is string =>
  model !== undefined && model.trim() !== "" && !/^<.*>$/.test(model)
