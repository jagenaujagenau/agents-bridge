import { Schema } from "effect"

export const TextContent = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String
}).pipe(Schema.annotate({ identifier: "TextContent" }))
export type TextContent = typeof TextContent.Type

export const CodeContent = Schema.Struct({
  type: Schema.tag("code"),
  code: Schema.String,
  language: Schema.optionalKey(Schema.String)
}).pipe(Schema.annotate({ identifier: "CodeContent" }))
export type CodeContent = typeof CodeContent.Type

export const FileContent = Schema.Struct({
  type: Schema.tag("file"),
  path: Schema.String
}).pipe(Schema.annotate({ identifier: "FileContent" }))
export type FileContent = typeof FileContent.Type

export const ImageContent = Schema.Struct({
  type: Schema.tag("image"),
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String)
}).pipe(Schema.annotate({ identifier: "ImageContent" }))
export type ImageContent = typeof ImageContent.Type

export const ContentBlock = Schema.Union([TextContent, CodeContent, FileContent, ImageContent]).pipe(
  Schema.toTaggedUnion("type")
)
export type ContentBlock = typeof ContentBlock.Type

export const text = (value: string): TextContent => ({ type: "text", text: value })

/** Concatenate the text of all text blocks. Useful for consumers that only render plain text. */
export const plainText = (content: ReadonlyArray<ContentBlock>): string =>
  content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
