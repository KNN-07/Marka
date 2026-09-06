import pdfMake from "pdfmake/build/pdfmake";
import pdfFonts from "pdfmake/build/vfs_fonts";
import type {
  Content,
  ContentText,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  WidthType,
} from "docx";
import type { ParagraphChild, IRunOptions } from "docx";
import type { Block, Run } from "./document";
import { resolveResources } from "./resources";
import type { Raster } from "./resources";

function pdfBlocks(blocks: Block[], resources: Map<Run, Raster>): Content[] {
  return blocks.flatMap((block): Content[] => {
    if (block.kind === "table") {
      const columns = Math.max(...block.rows.map((row) => row.length));
      if (!columns) return [];
      return [
        {
          table: {
            headerRows: block.header ? 1 : 0,
            widths: Array.from({ length: columns }, () => "*"),
            body: block.rows.map((row, rowIndex) =>
              Array.from({ length: columns }, (_, index) => ({
                stack: pdfBlocks(row[index] ?? [], resources),
                fillColor:
                  block.header && rowIndex === 0 ? "#f4f7f8" : undefined,
              })),
            ),
          },
          layout: "lightHorizontalLines",
          margin: [0, 6, 0, 10],
        },
      ];
    }
    const output: Content[] = [];
    let text: ContentText[] = [];
    let first = true;
    const flush = () => {
      if (!text.length) return;
      output.push({
        text: [
          ...(first && block.marker ? [{ text: `${block.marker} ` }] : []),
          ...text,
        ],
        headlineLevel: block.heading,
        fontSize: block.heading
          ? [22, 18, 15, 13, 12, 11][block.heading - 1]
          : block.code
            ? 9
            : 11,
        bold: !!block.heading,
        italics: block.quote,
        preserveLeadingSpaces: !!block.code,
        margin: [
          block.quote ? 14 : (block.depth ?? 0) * 14,
          block.heading ? 12 : 0,
          0,
          8,
        ],
        color: "#26323b",
      });
      text = [];
      first = false;
    };
    for (const run of block.runs) {
      const image = resources.get(run);
      if (image) {
        flush();
        output.push({
          image: image.url,
          fit: [
            Math.min(image.width * 0.75, 481),
            Math.min(image.height * 0.75, 650),
          ],
          margin: [0, 3, 0, 8],
        });
      } else
        text.push({
          text: run.text ?? "",
          bold: run.bold || !!block.heading,
          italics: run.italic,
          decoration: run.strike ? "lineThrough" : undefined,
          background: run.code ? "#f4f7f8" : undefined,
        });
    }
    flush();
    return output;
  });
}

function docxBlocks(
  blocks: Block[],
  resources: Map<Run, Raster>,
): (Paragraph | Table)[] {
  return blocks.map((block) => {
    if (block.kind === "table") {
      const columns = Math.max(...block.rows.map((row) => row.length));
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map(
          (row, rowIndex) =>
            new TableRow({
              tableHeader: block.header && rowIndex === 0,
              children: Array.from({ length: columns }, (_, index) => {
                const children = docxBlocks(row[index] ?? [], resources);
                if (
                  !children.length ||
                  children[children.length - 1] instanceof Table
                )
                  children.push(new Paragraph(""));
                return new TableCell({
                  children,
                  shading:
                    block.header && rowIndex === 0
                      ? { fill: "F4F7F8" }
                      : undefined,
                });
              }),
            }),
        ),
      });
    }
    const children: ParagraphChild[] = [];
    if (block.marker) children.push(new TextRun(`${block.marker} `));
    for (const run of block.runs) {
      const image = resources.get(run);
      if (image) {
        const scale = Math.min(1, 640 / image.width, 860 / image.height);
        children.push(
          new ImageRun({
            type: "png",
            data: image.data,
            transformation: {
              width: Math.max(1, Math.round(image.width * scale)),
              height: Math.max(1, Math.round(image.height * scale)),
            },
            altText: {
              name: run.math ? "Equation" : "Image",
              title: run.alt ?? "",
              description: run.alt ?? "",
            },
          }),
        );
      } else {
        const style: IRunOptions = {
          bold: run.bold,
          italics: run.italic || block.quote,
          strike: run.strike,
          font: run.code || block.code ? "Courier New" : undefined,
          size: block.code ? 18 : undefined,
        };
        const lines = (run.text ?? "").split("\n");
        lines.forEach((line, index) =>
          children.push(
            new TextRun({ ...style, text: line, break: index ? 1 : undefined }),
          ),
        );
      }
    }
    const headings = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
      HeadingLevel.HEADING_5,
      HeadingLevel.HEADING_6,
    ];
    return new Paragraph({
      children,
      heading: block.heading ? headings[block.heading - 1] : undefined,
      keepNext: !!block.heading,
      spacing: { after: 140, before: block.heading ? 180 : 0 },
      indent:
        block.marker || block.depth || block.quote
          ? {
              left: 280 + (block.depth ?? 0) * 280,
              hanging: block.marker ? 240 : 0,
            }
          : undefined,
      shading: block.code ? { fill: "F4F7F8" } : undefined,
    });
  });
}

export async function renderBinary(
  format: "pdf" | "docx",
  title: string,
  blocks: Block[],
): Promise<Uint8Array> {
  const resources = await resolveResources(blocks);
  if (format === "pdf") {
    const definition: TDocumentDefinitions = {
      info: { title, author: "Marka", creator: "Marka" },
      pageSize: "A4",
      pageMargins: [57, 57, 57, 57],
      defaultStyle: { font: "Roboto", fontSize: 11, lineHeight: 1.25 },
      content: pdfBlocks(blocks, resources),
      pageBreakBefore: (current, following) =>
        !!current.headlineLevel && following.length === 0,
      footer: (current, count) => ({
        text: `${current} / ${count}`,
        alignment: "center",
        fontSize: 9,
        color: "#63727c",
      }),
    };
    return new Promise<Uint8Array>((resolve, reject) => {
      try {
        // All fonts/images are local: synchronous stream creation propagates
        // layout errors, unlike pdfmake 0.2's callback-only URL resolver.
        const stream = pdfMake
          .createPdf(definition, undefined, undefined, pdfFonts)
          .getStream();
        const chunks: Uint8Array[] = [];
        let length = 0;
        stream.on("data", (chunk: Uint8Array) => {
          length += chunk.byteLength;
          if (length > 64 * 1024 * 1024) {
            stream.destroy(
              new Error("PDF exceeds 64 MiB. Split the document."),
            );
          } else chunks.push(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => {
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve(bytes);
        });
        stream.end();
      } catch (error) {
        reject(error);
      }
    });
  }
  const document = new Document({
    title,
    creator: "Marka",
    description: "Exported from Marka",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22, color: "26323B" } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children: docxBlocks(blocks, resources),
      },
    ],
  });
  return new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer());
}
