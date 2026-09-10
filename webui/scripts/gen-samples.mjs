// 生成演示用的最小合法 PDF（ASCII 内容，Helvetica），输出到 public/samples/
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples')
mkdirSync(outDir, { recursive: true })

const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\) /g, '\\) ')

function makePdf(title, lines) {
  let y = 770
  const parts = [`BT /F1 18 Tf 60 800 Td (${esc(title)}) Tj ET`]
  for (const l of lines) {
    parts.push(`BT /F1 11 Tf 60 ${y} Td (${esc(l)}) Tj ET`)
    y -= 19
  }
  parts.push(`0.31 0.42 0.99 RG 2 w 60 ${y} m 535 ${y} l S`)
  const content = parts.join('\n')
  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[5] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefPos = pdf.length
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return pdf
}

const docs = {
  'sample-product.pdf': makePdf('Yunshu Document Assistant - Product Introduction', [
    'Version 2.4  |  Updated 2026-08-20  (Demo PDF for UI preview)',
    '',
    '1. Overview',
    'Yunshu Document Assistant is an intelligent document tool for',
    'importing, parsing and organizing PDF / Markdown knowledge.',
    '',
    '2. Feature Matrix',
    '- Knowledge base management: create / rename / delete',
    '- Document parsing: PaddleOCR-VL and MinerU engines',
    '- Content generation: LLM-organized Markdown output',
    '- Knowledge QA: retrieval-augmented chat with @kb',
    '',
    '3. Deployment',
    'Cloud SaaS or on-premise (4C8G minimum, CUDA GPU optional).',
    '',
    'This file is a generated sample for demonstration only.',
  ]),
  'sample-guide.pdf': makePdf('Quick Start Guide', [
    'Step 1  Create a knowledge base',
    'Step 2  Import PDF / Markdown documents',
    '        - PDF files are OCR-parsed immediately after upload',
    '        - Progress is shown in the document list',
    'Step 3  Adjust generation config in the bottom bar',
    'Step 4  Ask questions with @knowledge-base in Assistant',
    '',
    'FAQ',
    'Q: What if parsing fails?  A: Right-click the document and retry.',
    'Q: How to switch the parsing engine?  A: Settings -> Document Parsing.',
    '',
    'This file is a generated sample for demonstration only.',
  ]),
  'sample-review.pdf': makePdf('Architecture Review Notes - No.14', [
    'Time: 2026-08-28 14:00 - 16:30',
    'Attendees: Li, Wang, Zhao, Chen, Liu, Sun',
    '',
    'Topic 1: Split parsing service into stateless workers',
    '  - Redis queue, 3 automatic retries, 15 min timeout',
    '  - Decision: approved, gray release before 09-15 (Wang)',
    '',
    'Topic 2: Chunking strategy for long documents',
    '  - 512 tok: recall 91.2% / 1024 tok: 93.8% / 2048 tok: 92.1%',
    '  - Decision: 1024 tokens with 15% overlap (Chen)',
    '',
    'This file is a generated sample for demonstration only.',
  ]),
}

for (const [name, content] of Object.entries(docs)) {
  writeFileSync(join(outDir, name), content, 'latin1')
  console.log('written', name)
}
