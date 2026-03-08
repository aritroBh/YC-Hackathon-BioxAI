import fs from "fs";

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const PAGE_MARGIN = 1440;
const TABLE_WIDTH = 9360;
const BODY_LINE = 276;
const FULL_WIDTH_PX = 624;
const HALF_WIDTH_PX = 472;
const CELL_MARGINS = {
  top: 80,
  bottom: 80,
  left: 120,
  right: 120,
};
const TABLE_BORDER = {
  style: BorderStyle.SINGLE,
  color: "d6dae5",
  size: 4,
};
const NO_BORDER = {
  top: { style: BorderStyle.NONE, size: 0, color: "ffffff" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "ffffff" },
  left: { style: BorderStyle.NONE, size: 0, color: "ffffff" },
  right: { style: BorderStyle.NONE, size: 0, color: "ffffff" },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "ffffff" },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: "ffffff" },
};

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function hex(color) {
  return String(color || "").replace(/^#/, "") || "000000";
}

function pxFromChart(chart, targetWidth) {
  const width = targetWidth;
  const ratio = Number(chart?.height_inches || 1) / Number(chart?.width_inches || 1);
  return {
    width,
    height: Math.max(1, Math.round(width * ratio)),
  };
}

function bodyParagraph(text, options = {}) {
  const paragraph = options.paragraph || {};
  return new Paragraph({
    ...paragraph,
    spacing: { after: 120, line: BODY_LINE, ...(paragraph.spacing || {}) },
    children: [
      new TextRun({
        text: String(text || ""),
        font: "Arial",
        size: 22,
        color: "1f2430",
        ...(options.run || {}),
      }),
    ],
  });
}

function centerParagraph(text, options = {}) {
  return bodyParagraph(text, {
    paragraph: {
      alignment: AlignmentType.CENTER,
      spacing: { after: 120, line: BODY_LINE, ...(options.paragraph?.spacing || {}) },
      ...(options.paragraph || {}),
    },
    run: options.run || {},
  });
}

function labelParagraph(label, value) {
  return new Paragraph({
    spacing: { after: 80, line: BODY_LINE },
    children: [
      new TextRun({
        text: `${label}: `,
        bold: true,
        font: "Arial",
        size: 22,
        color: "1f2430",
      }),
      new TextRun({
        text: String(value || ""),
        font: "Arial",
        size: 22,
        color: "374151",
      }),
    ],
  });
}

function sectionTitle(text, level) {
  const config = {
    [HeadingLevel.HEADING_1]: {
      size: 36,
      bold: true,
      italics: false,
      spacing: { before: 240, after: 120 },
    },
    [HeadingLevel.HEADING_2]: {
      size: 28,
      bold: true,
      italics: false,
      spacing: { before: 180, after: 80 },
    },
    [HeadingLevel.HEADING_3]: {
      size: 24,
      bold: true,
      italics: true,
      spacing: { before: 140, after: 60 },
    },
  }[level];

  return new Paragraph({
    heading: level,
    spacing: { line: BODY_LINE, ...config.spacing },
    children: [
      new TextRun({
        text,
        font: "Arial",
        color: "111827",
        size: config.size,
        bold: config.bold,
        italics: config.italics,
      }),
    ],
  });
}

function quoteParagraph(text) {
  return new Paragraph({
    indent: { left: 720 },
    spacing: { before: 80, after: 120, line: BODY_LINE },
    children: [
      new TextRun({
        text: String(text || ""),
        italics: true,
        color: "555555",
        font: "Arial",
        size: 22,
      }),
    ],
  });
}

function spacer(after = 120) {
  return new Paragraph({
    spacing: { after },
    children: [new TextRun({ text: "" })],
  });
}

function makeCell(children, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: CELL_MARGINS,
    borders: {
      top: TABLE_BORDER,
      bottom: TABLE_BORDER,
      left: TABLE_BORDER,
      right: TABLE_BORDER,
    },
    ...options,
    children,
  });
}

function makeBorderlessCell(children, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: CELL_MARGINS,
    borders: NO_BORDER,
    children,
  });
}

function headerCell(text, width) {
  return makeCell(
    [
      new Paragraph({
        spacing: { after: 0, line: BODY_LINE },
        children: [
          new TextRun({
            text,
            bold: true,
            color: "ffffff",
            font: "Arial",
            size: 22,
          }),
        ],
      }),
    ],
    width,
    {
      shading: {
        type: ShadingType.CLEAR,
        fill: "1a1f2e",
        color: "auto",
      },
    },
  );
}

function bodyCell(text, width, align = AlignmentType.LEFT, run = {}) {
  return makeCell(
    [
      new Paragraph({
        alignment: align,
        spacing: { after: 0, line: BODY_LINE },
        children: [
          new TextRun({
            text: String(text || ""),
            font: "Arial",
            size: 22,
            color: "1f2430",
            ...run,
          }),
        ],
      }),
    ],
    width,
  );
}

function makeTable(columnWidths, rows, options = {}) {
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths,
    margins: CELL_MARGINS,
    ...options,
    rows,
  });
}

function frictionDistributionTable(rows) {
  const columnWidths = [2400, 2200, 2200, 2560];
  return makeTable(columnWidths, [
    new TableRow({
      children: [
        headerCell("Risk Level", columnWidths[0]),
        headerCell("Node Count", columnWidths[1]),
        headerCell("% of Total", columnWidths[2]),
        headerCell("Color Code", columnWidths[3]),
      ],
    }),
    ...rows.map((row) => new TableRow({
      children: [
        bodyCell(row.risk_level, columnWidths[0]),
        bodyCell(String(row.node_count), columnWidths[1], AlignmentType.CENTER),
        bodyCell(row.percentage, columnWidths[2], AlignmentType.CENTER),
        bodyCell(row.color_code, columnWidths[3]),
      ],
    })),
  ]);
}

function semanticMapTable(rows) {
  const columnWidths = [2500, 2500, 2200, 2160];
  return makeTable(columnWidths, [
    new TableRow({
      children: [
        headerCell("Entity A", columnWidths[0]),
        headerCell("Entity B", columnWidths[1]),
        headerCell("Contradiction Count", columnWidths[2]),
        headerCell("Max Friction", columnWidths[3]),
      ],
    }),
    ...rows.map((row) => new TableRow({
      children: [
        bodyCell(row.entity_a, columnWidths[0]),
        bodyCell(row.entity_b, columnWidths[1]),
        bodyCell(String(row.contradiction_count), columnWidths[2], AlignmentType.CENTER),
        bodyCell(Number(row.max_friction || 0).toFixed(2), columnWidths[3], AlignmentType.CENTER),
      ],
    })),
  ]);
}

function discrepancyTable(rows) {
  const columnWidths = [2400, 1900, 1900, 1560, 1600];
  return makeTable(columnWidths, [
    new TableRow({
      children: [
        headerCell("Compound", columnWidths[0]),
        headerCell("Private IC50", columnWidths[1]),
        headerCell("Published IC50", columnWidths[2]),
        headerCell("Fold Difference", columnWidths[3]),
        headerCell("Risk", columnWidths[4]),
      ],
    }),
    ...rows.map((row) => new TableRow({
      children: [
        bodyCell(row.compound, columnWidths[0]),
        bodyCell(row.private_ic50, columnWidths[1], AlignmentType.CENTER),
        bodyCell(row.published_ic50, columnWidths[2], AlignmentType.CENTER),
        bodyCell(row.fold_difference, columnWidths[3], AlignmentType.CENTER),
        bodyCell(row.risk, columnWidths[4], AlignmentType.CENTER, {
          bold: Boolean(row.risk_bold),
          color: hex(row.risk_color || "#1f2430"),
        }),
      ],
    })),
  ]);
}

function bindingAffinitiesTable(rows) {
  const columnWidths = [3000, 3000, 3360];
  return makeTable(columnWidths, [
    new TableRow({
      children: [
        headerCell("", columnWidths[0]),
        headerCell("Affinity (kcal/mol)", columnWidths[1]),
        headerCell("Interpretation", columnWidths[2]),
      ],
    }),
    ...rows.map((row) => new TableRow({
      children: [
        bodyCell(row.label, columnWidths[0]),
        bodyCell(row.affinity, columnWidths[1], AlignmentType.CENTER),
        bodyCell(row.interpretation, columnWidths[2], AlignmentType.CENTER),
      ],
    })),
  ]);
}

function chartRun(chart, targetWidth) {
  if (!chart?.path || !fs.existsSync(chart.path)) {
    return null;
  }
  const data = fs.readFileSync(chart.path);
  const { width, height } = pxFromChart(chart, targetWidth);
  return new ImageRun({
    type: "png",
    data,
    transformation: { width, height },
  });
}

function figureCaption(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120, line: BODY_LINE },
    children: [
      new TextRun({
        text,
        italics: true,
        font: "Arial",
        size: 18,
        color: "888888",
      }),
    ],
  });
}

function fullWidthFigure(chart, caption) {
  const image = chartRun(chart, FULL_WIDTH_PX);
  if (!image) {
    return [];
  }
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [image],
    }),
    figureCaption(caption),
  ];
}

function figureCell(chart, caption) {
  const image = chartRun(chart, HALF_WIDTH_PX);
  if (!image) {
    return makeBorderlessCell([spacer(40)], 4680);
  }
  return makeBorderlessCell([
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 30 },
      children: [image],
    }),
    figureCaption(caption),
  ], 4680);
}

function halfWidthFigureTable(leftChart, leftCaption, rightChart, rightCaption) {
  if (!leftChart?.path && !rightChart?.path) {
    return null;
  }
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: [4680, 4680],
    borders: NO_BORDER,
    rows: [
      new TableRow({
        children: [
          figureCell(leftChart, leftCaption),
          figureCell(rightChart, rightCaption),
        ],
      }),
    ],
  });
}

function contradictionSection(item) {
  const children = [
    sectionTitle(item.heading, HeadingLevel.HEADING_2),
    new Paragraph({
      spacing: { after: 80, line: BODY_LINE },
      children: [
        new TextRun({
          text: item.risk_badge,
          bold: true,
          color: hex(item.risk_color),
          font: "Arial",
          size: 22,
        }),
      ],
    }),
    quoteParagraph(item.claim_text),
    labelParagraph("Polarity", item.polarity),
    labelParagraph("Cell line", item.cell_line),
    labelParagraph("Quantitative value", item.quantitative_value),
  ];

  if (item.contradiction_summary) {
    children.push(
      new Paragraph({
        spacing: { before: 40, after: 80, line: BODY_LINE },
        children: [
          new TextRun({
            text: item.contradiction_summary,
            bold: true,
            font: "Arial",
            size: 22,
            color: "1f2430",
          }),
        ],
      }),
    );
  }

  (item.contradictions || []).forEach((contradiction) => {
    children.push(
      new Paragraph({
        numbering: {
          reference: "dialectic-bullets",
          level: 0,
        },
        spacing: { after: 60, line: BODY_LINE },
        children: [
          new TextRun({
            text: `${contradiction.claim_text} (${contradiction.source})`,
            font: "Arial",
            size: 22,
            color: "374151",
          }),
        ],
      }),
    );
  });

  if (item.skeptic_rationale) {
    children.push(labelParagraph("Interpretation", item.skeptic_rationale));
  }

  if (item.tamarind_verdict) {
    children.push(
      sectionTitle("\u2b21 Structural Verdict", HeadingLevel.HEADING_3),
      labelParagraph("Verdict", item.tamarind_verdict.verdict || "Not reported"),
      labelParagraph("Structural rationale", item.tamarind_verdict.structural_rationale || "Not reported"),
      labelParagraph(
        "Confidence",
        item.tamarind_verdict.confidence != null
          ? `${Math.round(Number(item.tamarind_verdict.confidence) * 100)}%`
          : "Not reported",
      ),
    );

    if (item.tamarind_verdict.binding_affinity_a !== null && item.tamarind_verdict.binding_affinity_a !== undefined) {
      children.push(labelParagraph("Binding affinity A", item.tamarind_verdict.binding_affinity_a));
    }
    if (item.tamarind_verdict.binding_affinity_b !== null && item.tamarind_verdict.binding_affinity_b !== undefined) {
      children.push(labelParagraph("Binding affinity B", item.tamarind_verdict.binding_affinity_b));
    }

    children.push(labelParagraph("Source", "Tamarind Bio DiffDock - PDB 6OIM (KRAS G12C)"));
  }

  children.push(spacer(120));
  return children;
}

function methodologySection(section) {
  const children = [sectionTitle(section.heading, HeadingLevel.HEADING_2)];
  (section.paragraphs || []).forEach((paragraph) => {
    children.push(bodyParagraph(paragraph));
  });
  return children;
}

function citationParagraph(citation, index) {
  const year = citation.year ?? "n.d.";
  return new Paragraph({
    spacing: { after: 100, line: BODY_LINE },
    children: [
      new TextRun({
        text: `[${index}] `,
        bold: true,
        font: "Arial",
        size: 22,
        color: "1f2430",
      }),
      new TextRun({
        text: `${citation.authors} (${year}). "${citation.claim_text}" ${citation.journal}. ${citation.url}`,
        font: "Arial",
        size: 22,
        color: "374151",
      }),
    ],
  });
}

function structuralDockingSection(data) {
  const charts = data.charts || {};
  const docking = data.experiment_results?.structural_docking || {};
  const children = [
    sectionTitle("Structural Docking Results", HeadingLevel.HEADING_2),
  ];

  const chartTable = halfWidthFigureTable(
    charts.tamarind_verdicts_pie,
    "Figure 2. Structural verdict distribution across Tamarind DiffDock arbitration outcomes.",
    charts.binding_affinity_scatter,
    "Figure 3. Binding affinity comparison across contradicting claim pairs.",
  );
  if (chartTable) {
    children.push(chartTable);
  }

  if (!(docking.sections || []).length) {
    children.push(bodyParagraph("No structural arbitration sections were available for this session."));
    return children;
  }

  docking.sections.forEach((section) => {
    children.push(
      sectionTitle(section.heading, HeadingLevel.HEADING_3),
      new Paragraph({
        spacing: { after: 80, line: BODY_LINE },
        children: [
          new TextRun({
            text: section.verdict_display,
            bold: true,
            font: "Arial",
            size: 22,
            color: hex(section.verdict_color),
          }),
        ],
      }),
      bodyParagraph(section.structural_rationale),
      bindingAffinitiesTable(section.binding_rows || []),
      spacer(80),
      labelParagraph("Confidence", section.confidence),
      bodyParagraph(section.job_note),
    );
    if (section.mock) {
      children.push(bodyParagraph("Demo mode - structural values are illustrative.", {
        run: { italics: true, color: "555555" },
      }));
    }
  });

  return children;
}

function createDocument(data) {
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: "Page ",
            font: "DM Mono",
            size: 18,
            color: "6b7590",
          }),
          new TextRun({
            children: [PageNumber.CURRENT],
            font: "DM Mono",
            size: 18,
            color: "6b7590",
          }),
        ],
      }),
    ],
  });

  const charts = data.charts || {};
  const experimentResults = data.experiment_results || {};
  const ic50Analysis = experimentResults.ic50_analysis || {};
  const readiness = data.readiness || {};

  const children = [
    spacer(1200),
    centerParagraph(data.report_title, {
      paragraph: { spacing: { after: 240 } },
      run: { bold: true, size: 40, color: "111827" },
    }),
    centerParagraph(data.subtitle, {
      paragraph: { spacing: { after: 280 } },
      run: { size: 22, color: "4b5563" },
    }),
    centerParagraph(data.cover_status || "Experiment Status: ALL TAMARIND JOBS COMPLETE", {
      paragraph: { spacing: { after: 120 } },
      run: { size: 22, color: "00e5a0", bold: true },
    }),
    centerParagraph(`Date: ${data.date}`, {
      paragraph: { spacing: { after: 100 } },
      run: { color: "374151" },
    }),
    centerParagraph(`Session ID: ${data.session_id}`, {
      paragraph: { spacing: { after: 100 } },
      run: { color: "374151" },
    }),
    centerParagraph(`Node Count: ${data.node_count}`, {
      paragraph: { spacing: { after: 100 } },
      run: { color: "374151" },
    }),
    centerParagraph(data.cover_counts || "", {
      paragraph: { spacing: { after: 100 } },
      run: { color: "374151" },
    }),
    centerParagraph(`Readiness: ${Number(readiness.percent_complete || 0).toFixed(1)}%`, {
      paragraph: { spacing: { after: 360 } },
      run: { color: "374151" },
    }),
    new Paragraph({ children: [new PageBreak()] }),

    bodyParagraph("Table of Contents", {
      paragraph: { spacing: { after: 160 } },
      run: { bold: true, size: 36, color: "111827" },
    }),
    new TableOfContents("Contents", {
      beginDirty: true,
      hyperlink: true,
      headingStyleRange: "1-3",
      pageNumbersEntryLevelsRange: "1-3",
      useAppliedParagraphOutlineLevel: true,
    }),
    new Paragraph({ children: [new PageBreak()] }),

    sectionTitle("Executive Summary", HeadingLevel.HEADING_1),
    ...(data.executive_summary || []).map((paragraph) => bodyParagraph(paragraph)),

    sectionTitle("Experiment Results", HeadingLevel.HEADING_1),
    sectionTitle("IC50 Assay Analysis", HeadingLevel.HEADING_2),
    ...fullWidthFigure(
      charts.ic50_comparison_bar,
      "Figure 1. IC50 values (nM, log scale) comparing private assay results against published literature per compound.",
    ),
    discrepancyTable(ic50Analysis.discrepancy_rows || []),
    ...structuralDockingSection(data),

    sectionTitle("Friction Distribution", HeadingLevel.HEADING_1),
    ...fullWidthFigure(
      charts.friction_distribution_bar,
      "Figure 4. Friction score distribution across critical, high, medium, and low risk tiers.",
    ),
    frictionDistributionTable(data.friction_distribution || []),
    spacer(100),
    bodyParagraph(data.friction_interpretation),

    sectionTitle("Contradiction Analysis", HeadingLevel.HEADING_1),
    ...fullWidthFigure(
      charts.contradiction_network,
      "Figure 5. Contradiction network. Node size = citation count. Edge width = friction score.",
    ),
    ...(data.contradiction_analysis?.length
      ? data.contradiction_analysis.flatMap((item) => contradictionSection(item))
      : [
          bodyParagraph("No nodes cleared the high-risk threshold for contradiction review.", {
            run: { color: "374151" },
          }),
        ]),

    sectionTitle("Semantic Map Summary", HeadingLevel.HEADING_1),
    semanticMapTable(data.semantic_map_pairs || []),
    spacer(100),
    bodyParagraph(data.semantic_map_methodology),

    sectionTitle("Methodology", HeadingLevel.HEADING_1),
    ...((data.methodology_sections || []).flatMap((section) => methodologySection(section))),

    sectionTitle("Citations", HeadingLevel.HEADING_1),
    ...((data.citations || []).length
      ? data.citations.map((citation, index) => citationParagraph(citation, index + 1))
      : [
          bodyParagraph("No citation URLs were available for this session.", {
            run: { color: "374151" },
          }),
        ]),
    ...(data.citation_footer || [])
      .filter(Boolean)
      .map((paragraph) => bodyParagraph(paragraph, {
        run: { italics: paragraph.startsWith("*"), color: paragraph.startsWith("*") ? "555555" : "374151" },
      })),
  ];

  return new Document({
    creator: "Dialectic",
    title: data.report_title,
    description: "Target validation risk report",
    features: {
      updateFields: true,
    },
    numbering: {
      config: [
        {
          reference: "dialectic-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: {
                    left: 720,
                    hanging: 360,
                  },
                  spacing: {
                    after: 80,
                    line: BODY_LINE,
                  },
                },
                run: {
                  font: "Arial",
                  size: 22,
                  color: "374151",
                },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
            },
            size: {
              width: PAGE_WIDTH,
              height: PAGE_HEIGHT,
            },
          },
        },
        footers: {
          default: footer,
        },
        children,
      },
    ],
  });
}

async function main() {
  const raw = await readStdin();
  const data = JSON.parse(raw || "{}");
  const document = createDocument(data);
  const buffer = await Packer.toBuffer(document);
  process.stdout.write(buffer);
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
