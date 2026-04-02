#!/usr/bin/env node
/**
 * Canvas Student MCP Server
 *
 * Exposes student-focused Canvas LMS tools:
 *   - Course listing with grades
 *   - File browsing and download URL retrieval
 *   - Assignment and submission lookup
 *   - Announcements, to-do list, and upcoming events
 *
 * Required environment variables:
 *   CANVAS_BASE_URL  — e.g. https://boisestateuniversity.instructure.com
 *   CANVAS_API_TOKEN — generated in Canvas → Account → Settings → New Access Token
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CanvasClient, handleApiError } from "./client.js";

// ---------------------------------------------------------------------------
// Config & shared client
// ---------------------------------------------------------------------------

const BASE_URL = process.env.CANVAS_BASE_URL?.replace(/\/$/, "");
const API_TOKEN = process.env.CANVAS_API_TOKEN;

if (!BASE_URL || !API_TOKEN) {
  console.error(
    "ERROR: CANVAS_BASE_URL and CANVAS_API_TOKEN environment variables are required.\n" +
      "  Example: CANVAS_BASE_URL=https://boisestateuniversity.instructure.com\n" +
      "  Generate a token in Canvas → Account → Settings → New Access Token"
  );
  process.exit(1);
}

const canvas = new CanvasClient({ baseUrl: BASE_URL, apiToken: API_TOKEN });
const CHARACTER_LIMIT = 25_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

enum Fmt {
  Markdown = "markdown",
  JSON = "json",
}

/** Truncate a JSON string to CHARACTER_LIMIT, appending a notice if cut. */
function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n[Response truncated — use filters or pagination to narrow results]"
  );
}

/** Format a Canvas timestamp into a readable string. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** Format bytes into KB/MB. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "canvas-student-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: canvas_list_courses
// ---------------------------------------------------------------------------

const ListCoursesSchema = z.object({
  enrollment_state: z
    .enum(["active", "completed", "all"])
    .default("active")
    .describe("Filter by enrollment state (default: active)"),
  include_grades: z
    .boolean()
    .default(true)
    .describe("Whether to include current grade/score in each course"),
  response_format: z
    .nativeEnum(Fmt)
    .default(Fmt.Markdown)
    .describe("'markdown' for human-readable, 'json' for structured data"),
});

server.registerTool(
  "canvas_list_courses",
  {
    title: "List Canvas Courses",
    description: `List all courses the current student is enrolled in, with optional grade data.

Args:
  - enrollment_state ('active' | 'completed' | 'all'): Filter courses (default: 'active')
  - include_grades (boolean): Attach current score/grade to each course (default: true)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  List of courses with id, name, course_code, term, and (if include_grades=true)
  current_grade and current_score from your enrollment.

Examples:
  - "What courses am I taking?" → default params
  - "Show me all my completed courses" → enrollment_state='completed'`,
    inputSchema: ListCoursesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const include: string[] = ["term"];
      if (params.include_grades) include.push("total_scores");

      const result = await canvas.getPaginated<Record<string, unknown>>(
        "/courses",
        {
          enrollment_type: "student",
          enrollment_state: params.enrollment_state === "all" ? undefined : params.enrollment_state,
          "include[]": include,
          per_page: 50,
        }
      );

      if (!result.items.length) {
        return { content: [{ type: "text", text: "No courses found." }] };
      }

      const courses = result.items.map((c) => {
        const enrollment = (c.enrollments as Array<Record<string, unknown>>)?.[0];
        return {
          id: c.id,
          name: c.name,
          course_code: c.course_code,
          term: (c.term as Record<string, unknown> | undefined)?.name ?? null,
          workflow_state: c.workflow_state,
          current_grade: enrollment?.computed_current_grade ?? null,
          current_score: enrollment?.computed_current_score ?? null,
          final_grade: enrollment?.computed_final_grade ?? null,
          final_score: enrollment?.computed_final_score ?? null,
        };
      });

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(courses, null, 2)) }],
          structuredContent: { courses, has_more: result.hasMore },
        };
      }

      const lines = [
        `# My Canvas Courses (${courses.length}${result.hasMore ? "+" : ""})`,
        "",
      ];
      for (const c of courses) {
        lines.push(`## ${c.name} (${c.course_code})`);
        lines.push(`- **ID**: ${c.id}`);
        if (c.term) lines.push(`- **Term**: ${c.term}`);
        if (params.include_grades) {
          const grade = c.current_grade ?? "N/A";
          const score = c.current_score != null ? `${c.current_score}%` : "N/A";
          lines.push(`- **Current Grade**: ${grade} (${score})`);
        }
        lines.push("");
      }
      if (result.hasMore) lines.push("_More courses available — Canvas is paginating._");

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_get_my_grades
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_get_my_grades",
  {
    title: "Get My Grades",
    description: `Get your current grades across all active courses in one shot.

Returns:
  Each active course with current_grade, current_score, final_grade, final_score.
  Grades may show as null if not yet posted by the instructor.

No parameters required. Use canvas_list_courses with include_grades=true for
more filtering options.`,
    inputSchema: z.object({
      response_format: z
        .nativeEnum(Fmt)
        .default(Fmt.Markdown)
        .describe("'markdown' for human-readable, 'json' for structured data"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await canvas.getPaginated<Record<string, unknown>>("/courses", {
        enrollment_type: "student",
        enrollment_state: "active",
        "include[]": ["total_scores", "term"],
        per_page: 50,
      });

      if (!result.items.length) {
        return { content: [{ type: "text", text: "No active courses found." }] };
      }

      const grades = result.items.map((c) => {
        const enrollment = (c.enrollments as Array<Record<string, unknown>>)?.[0];
        return {
          course_id: c.id,
          course_name: c.name,
          course_code: c.course_code,
          term: (c.term as Record<string, unknown> | undefined)?.name ?? null,
          current_grade: enrollment?.computed_current_grade ?? null,
          current_score: enrollment?.computed_current_score ?? null,
          final_grade: enrollment?.computed_final_grade ?? null,
          final_score: enrollment?.computed_final_score ?? null,
        };
      });

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(grades, null, 2)) }],
          structuredContent: { grades },
        };
      }

      const lines = ["# My Current Grades", ""];
      for (const g of grades) {
        const grade = g.current_grade ?? "Not posted";
        const score = g.current_score != null ? `${g.current_score}%` : "—";
        lines.push(`## ${g.course_name}`);
        lines.push(`- **Grade**: ${grade} | **Score**: ${score}`);
        if (g.term) lines.push(`- **Term**: ${g.term}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_list_assignments
// ---------------------------------------------------------------------------

const ListAssignmentsSchema = z.object({
  course_id: z
    .string()
    .describe("Canvas course ID — get this from canvas_list_courses"),
  bucket: z
    .enum(["upcoming", "past", "overdue", "unsubmitted", "future", "undated", "all"])
    .default("upcoming")
    .describe("Filter by time bucket (default: upcoming)"),
  include_submission: z
    .boolean()
    .default(true)
    .describe("Attach your submission status/grade to each assignment"),
  response_format: z
    .nativeEnum(Fmt)
    .default(Fmt.Markdown)
    .describe("'markdown' for human-readable, 'json' for structured data"),
});

server.registerTool(
  "canvas_list_assignments",
  {
    title: "List Course Assignments",
    description: `List assignments for a specific course, optionally filtered by time bucket.

Args:
  - course_id (string): Canvas course ID (required) — get from canvas_list_courses
  - bucket ('upcoming' | 'past' | 'overdue' | 'unsubmitted' | 'future' | 'undated' | 'all'):
      Filter which assignments to return (default: 'upcoming')
  - include_submission (boolean): Attach your grade/score/submission status (default: true)
  - response_format ('markdown' | 'json')

Returns:
  Assignments with id, name, due_at, points_possible, submission_types, and if
  include_submission=true: your score, grade, and workflow_state.

Examples:
  - "What's due soon in ACCT 201?" → course_id='...', bucket='upcoming'
  - "What assignments am I missing?" → bucket='overdue' or 'unsubmitted'`,
    inputSchema: ListAssignmentsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const include: string[] = [];
      if (params.include_submission) include.push("submission");

      const queryParams: Record<string, unknown> = {
        per_page: 50,
        order_by: "due_at",
      };
      if (include.length) queryParams["include[]"] = include;
      if (params.bucket !== "all") queryParams["bucket"] = params.bucket;

      const result = await canvas.getPaginated<Record<string, unknown>>(
        `/courses/${params.course_id}/assignments`,
        queryParams
      );

      if (!result.items.length) {
        return {
          content: [
            {
              type: "text",
              text: `No assignments found for course ${params.course_id} with bucket '${params.bucket}'.`,
            },
          ],
        };
      }

      const assignments = result.items.map((a) => {
        const sub = a.submission as Record<string, unknown> | undefined;
        return {
          id: a.id,
          name: a.name,
          due_at: a.due_at,
          points_possible: a.points_possible,
          grading_type: a.grading_type,
          submission_types: a.submission_types,
          published: a.published,
          // submission fields (if requested)
          submission_state: sub?.workflow_state ?? null,
          score: sub?.score ?? null,
          grade: sub?.grade ?? null,
          submitted_at: sub?.submitted_at ?? null,
          late: sub?.late ?? null,
          missing: sub?.missing ?? null,
        };
      });

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(assignments, null, 2)) }],
          structuredContent: { assignments, has_more: result.hasMore },
        };
      }

      const lines = [
        `# Assignments — Course ${params.course_id} (${params.bucket})`,
        `${assignments.length}${result.hasMore ? "+" : ""} assignment(s)`,
        "",
      ];
      for (const a of assignments) {
        const pts = a.points_possible != null ? `${a.points_possible} pts` : "—";
        const due = fmtDate(a.due_at as string | null);
        lines.push(`## ${a.name}`);
        lines.push(`- **Due**: ${due} | **Points**: ${pts}`);
        if (params.include_submission) {
          const state = a.submission_state ?? "not submitted";
          const score = a.score != null ? `${a.score}/${a.points_possible}` : "—";
          const flags = [a.late && "LATE", a.missing && "MISSING"].filter(Boolean).join(", ");
          lines.push(`- **Submission**: ${state} | **Score**: ${score}${flags ? ` | ${flags}` : ""}`);
        }
        lines.push(`- **ID**: ${a.id}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_get_assignment_grade
// ---------------------------------------------------------------------------

const GetSubmissionSchema = z.object({
  course_id: z.string().describe("Canvas course ID"),
  assignment_id: z.string().describe("Canvas assignment ID — get from canvas_list_assignments"),
  include_comments: z
    .boolean()
    .default(true)
    .describe("Include instructor submission comments/feedback (default: true)"),
  response_format: z.nativeEnum(Fmt).default(Fmt.Markdown),
});

server.registerTool(
  "canvas_get_assignment_grade",
  {
    title: "Get Assignment Grade & Feedback",
    description: `Get your grade, score, and instructor feedback for a specific assignment submission.

Args:
  - course_id (string): Canvas course ID (required)
  - assignment_id (string): Assignment ID — get from canvas_list_assignments (required)
  - include_comments (boolean): Include instructor comments/feedback (default: true)
  - response_format ('markdown' | 'json')

Returns:
  score, grade, graded_at, workflow_state, submitted_at, late/missing flags,
  and any instructor comments if include_comments=true.

Examples:
  - "What did I get on the midterm?" → provide course_id and assignment_id
  - "Did the professor leave feedback on my essay?" → include_comments=true`,
    inputSchema: GetSubmissionSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const include = ["rubric_assessment"];
      if (params.include_comments) include.push("submission_comments");

      const sub = await canvas.get<Record<string, unknown>>(
        `/courses/${params.course_id}/assignments/${params.assignment_id}/submissions/self`,
        { "include[]": include }
      );

      const comments = (sub.submission_comments as Array<Record<string, unknown>>) ?? [];

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: JSON.stringify(sub, null, 2) }],
          structuredContent: sub,
        };
      }

      const lines = [
        `# Submission: Assignment ${params.assignment_id}`,
        "",
        `- **Grade**: ${sub.grade ?? "Not graded"}`,
        `- **Score**: ${sub.score ?? "—"}`,
        `- **Status**: ${sub.workflow_state ?? "—"}`,
        `- **Submitted**: ${fmtDate(sub.submitted_at as string | null)}`,
        `- **Graded**: ${fmtDate(sub.graded_at as string | null)}`,
        sub.late ? "- **LATE submission**" : "",
        sub.missing ? "- **MISSING**" : "",
        "",
      ].filter((l) => l !== "");

      if (params.include_comments && comments.length) {
        lines.push("## Instructor Feedback", "");
        for (const c of comments) {
          lines.push(
            `**${c.author_name ?? "Instructor"}** (${fmtDate(c.created_at as string | null)}):`,
            `> ${String(c.comment).replace(/\n/g, "\n> ")}`,
            ""
          );
        }
      } else if (params.include_comments) {
        lines.push("_No instructor comments yet._");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_get_course_submissions
// ---------------------------------------------------------------------------

const CourseSubmissionsSchema = z.object({
  course_id: z.string().describe("Canvas course ID"),
  workflow_state: z
    .enum(["submitted", "unsubmitted", "graded", "pending_review", "all"])
    .default("all")
    .describe("Filter by submission state (default: all)"),
  response_format: z.nativeEnum(Fmt).default(Fmt.Markdown),
});

server.registerTool(
  "canvas_get_course_submissions",
  {
    title: "Get All Course Submissions",
    description: `Get all of your submissions for every assignment in a course.

Args:
  - course_id (string): Canvas course ID (required)
  - workflow_state ('submitted' | 'unsubmitted' | 'graded' | 'pending_review' | 'all'):
      Filter by state (default: 'all')
  - response_format ('markdown' | 'json')

Returns:
  List of submissions with assignment_id, score, grade, submitted_at, workflow_state,
  late/missing flags.

Examples:
  - "Show all my grades in this course" → workflow_state='graded'
  - "What haven't I turned in?" → workflow_state='unsubmitted'`,
    inputSchema: CourseSubmissionsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const queryParams: Record<string, unknown> = {
        "student_ids[]": "self",
        per_page: 50,
        "include[]": ["assignment"],
      };
      if (params.workflow_state !== "all") {
        queryParams["workflow_state"] = params.workflow_state;
      }

      const result = await canvas.getPaginated<Record<string, unknown>>(
        `/courses/${params.course_id}/students/submissions`,
        queryParams
      );

      if (!result.items.length) {
        return {
          content: [{ type: "text", text: "No submissions found with those filters." }],
        };
      }

      const submissions = result.items.map((s) => {
        const a = s.assignment as Record<string, unknown> | undefined;
        return {
          assignment_id: s.assignment_id,
          assignment_name: a?.name ?? null,
          score: s.score,
          grade: s.grade,
          points_possible: a?.points_possible ?? null,
          submitted_at: s.submitted_at,
          graded_at: s.graded_at,
          workflow_state: s.workflow_state,
          late: s.late,
          missing: s.missing,
        };
      });

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(submissions, null, 2)) }],
          structuredContent: { submissions, has_more: result.hasMore },
        };
      }

      const lines = [
        `# Course Submissions — Course ${params.course_id}`,
        `${submissions.length}${result.hasMore ? "+" : ""} submission(s)`,
        "",
      ];
      for (const s of submissions) {
        const name = s.assignment_name ?? `Assignment ${s.assignment_id}`;
        const score =
          s.score != null
            ? `${s.score}${s.points_possible != null ? `/${s.points_possible}` : ""}`
            : "—";
        const flags = [s.late && "LATE", s.missing && "MISSING"].filter(Boolean).join(", ");
        lines.push(`### ${name}`);
        lines.push(`- **State**: ${s.workflow_state} | **Score**: ${score} | **Grade**: ${s.grade ?? "—"}`);
        if (flags) lines.push(`- **Flags**: ${flags}`);
        lines.push(`- **Submitted**: ${fmtDate(s.submitted_at as string | null)}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_list_course_files
// ---------------------------------------------------------------------------

const ListFilesSchema = z.object({
  course_id: z.string().describe("Canvas course ID"),
  search_term: z
    .string()
    .optional()
    .describe("Partial filename to search for (optional)"),
  content_type: z
    .string()
    .optional()
    .describe("Filter by MIME type, e.g. 'application/pdf', 'image/png' (optional)"),
  sort: z
    .enum(["name", "size", "created_at", "updated_at"])
    .default("name")
    .describe("Sort field (default: name)"),
  response_format: z.nativeEnum(Fmt).default(Fmt.Markdown),
});

server.registerTool(
  "canvas_list_course_files",
  {
    title: "List Course Files",
    description: `List files available in a Canvas course (files tab).

Args:
  - course_id (string): Canvas course ID (required)
  - search_term (string): Partial filename search (optional)
  - content_type (string): MIME type filter, e.g. 'application/pdf' (optional)
  - sort ('name' | 'size' | 'created_at' | 'updated_at'): Sort order (default: name)
  - response_format ('markdown' | 'json')

Returns:
  Files with id, display_name, content-type, size, and created_at.
  Use canvas_get_file_url with the id to get a download link.

Examples:
  - "What files are in my finance course?" → course_id='...'
  - "Find the syllabus PDF" → search_term='syllabus', content_type='application/pdf'`,
    inputSchema: ListFilesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const queryParams: Record<string, unknown> = {
        per_page: 50,
        sort: params.sort,
      };
      if (params.search_term) queryParams["search_term"] = params.search_term;
      if (params.content_type) queryParams["content_types[]"] = params.content_type;

      const result = await canvas.getPaginated<Record<string, unknown>>(
        `/courses/${params.course_id}/files`,
        queryParams
      );

      if (!result.items.length) {
        return {
          content: [
            {
              type: "text",
              text: "No files found. The course may have no files tab or files are restricted.",
            },
          ],
        };
      }

      const files = result.items.map((f) => ({
        id: f.id,
        display_name: f.display_name,
        filename: f.filename,
        content_type: f["content-type"],
        size_bytes: f.size,
        size_human: fmtSize(Number(f.size)),
        created_at: f.created_at,
        updated_at: f.updated_at,
        locked: f.locked,
      }));

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(files, null, 2)) }],
          structuredContent: { files, has_more: result.hasMore },
        };
      }

      const lines = [
        `# Files — Course ${params.course_id}`,
        `${files.length}${result.hasMore ? "+" : ""} file(s)`,
        "",
      ];
      for (const f of files) {
        lines.push(`### ${f.display_name}`);
        lines.push(`- **ID**: ${f.id} | **Size**: ${f.size_human} | **Type**: ${f.content_type ?? "—"}`);
        lines.push(`- **Uploaded**: ${fmtDate(f.created_at as string | null)}`);
        if (f.locked) lines.push("- **Locked** (may not be downloadable)");
        lines.push("");
      }
      lines.push("_Use `canvas_get_file_url` with a file ID to get the download link._");

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_get_file_url
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_get_file_url",
  {
    title: "Get File Download URL",
    description: `Get metadata and a short-lived download URL for a specific Canvas file.

Args:
  - file_id (string): Canvas file ID — get from canvas_list_course_files (required)
  - response_format ('markdown' | 'json')

Returns:
  display_name, content-type, size, created_at, and a url field that is a
  direct download link (short-lived, expires quickly — use immediately).

Note: The URL is pre-signed and temporary. Do not cache or delay use.

Examples:
  - "Give me the download link for that syllabus" → file_id='12345'`,
    inputSchema: z.object({
      file_id: z.string().describe("Canvas file ID"),
      response_format: z.nativeEnum(Fmt).default(Fmt.Markdown),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const f = await canvas.get<Record<string, unknown>>(`/files/${params.file_id}`);

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: JSON.stringify(f, null, 2) }],
          structuredContent: f,
        };
      }

      const lines = [
        `# File: ${f.display_name}`,
        "",
        `- **ID**: ${f.id}`,
        `- **Size**: ${fmtSize(Number(f.size))}`,
        `- **Type**: ${f["content-type"] ?? "—"}`,
        `- **Uploaded**: ${fmtDate(f.created_at as string | null)}`,
        f.locked ? "- **Locked** — may require instructor permissions" : "",
        "",
        `## Download URL`,
        `\`${f.url}\``,
        "",
        "_This URL is short-lived. Use it immediately._",
      ].filter((l) => l !== "");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_get_announcements
// ---------------------------------------------------------------------------

const AnnouncementsSchema = z.object({
  course_ids: z
    .array(z.string())
    .min(1)
    .describe("One or more Canvas course IDs to fetch announcements for"),
  start_date: z
    .string()
    .optional()
    .describe("ISO 8601 date to start from, e.g. '2026-01-01' (optional, defaults to 14 days ago)"),
  end_date: z
    .string()
    .optional()
    .describe("ISO 8601 end date (optional)"),
  response_format: z.nativeEnum(Fmt).default(Fmt.Markdown),
});

server.registerTool(
  "canvas_get_announcements",
  {
    title: "Get Course Announcements",
    description: `Get professor announcements from one or more courses.

Args:
  - course_ids (string[]): Array of Canvas course IDs (required) — e.g. ['12345', '67890']
  - start_date (string): Start date ISO 8601 (optional, defaults to 14 days ago)
  - end_date (string): End date ISO 8601 (optional)
  - response_format ('markdown' | 'json')

Returns:
  Announcements with title, message (HTML stripped), posted_at, and author.

Examples:
  - "Any new announcements from my professors?" → course_ids=['...', '...']
  - "Did Prof. Smith post anything this week?" → course_ids=['...'], start_date='2026-03-31'`,
    inputSchema: AnnouncementsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const contextCodes = params.course_ids.map((id) => `course_${id}`);
      const queryParams: Record<string, unknown> = {
        "context_codes[]": contextCodes,
        active_only: true,
        per_page: 50,
      };
      if (params.start_date) queryParams["start_date"] = params.start_date;
      if (params.end_date) queryParams["end_date"] = params.end_date;

      const result = await canvas.getPaginated<Record<string, unknown>>(
        "/announcements",
        queryParams
      );

      if (!result.items.length) {
        return {
          content: [{ type: "text", text: "No announcements found in that date range." }],
        };
      }

      // Strip basic HTML tags for readable text
      const stripHtml = (html: string) =>
        html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

      const announcements = result.items.map((a) => ({
        id: a.id,
        title: a.title,
        message: stripHtml(String(a.message ?? "")),
        posted_at: a.posted_at,
        context_code: a.context_code,
        author: (a.author as Record<string, unknown> | undefined)?.display_name ?? "Unknown",
      }));

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(announcements, null, 2)) }],
          structuredContent: { announcements, has_more: result.hasMore },
        };
      }

      const lines = [
        `# Announcements (${announcements.length}${result.hasMore ? "+" : ""})`,
        "",
      ];
      for (const a of announcements) {
        lines.push(`## ${a.title}`);
        lines.push(`**${a.author}** · ${fmtDate(a.posted_at as string | null)} · ${a.context_code}`);
        lines.push("");
        // Limit message length per announcement
        const msg = a.message.length > 800 ? a.message.slice(0, 800) + "…" : a.message;
        lines.push(msg, "");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_get_todo_items
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_get_todo_items",
  {
    title: "Get Student To-Do List",
    description: `Get Canvas's built-in student to-do list — assignments and quizzes that need action.

No required parameters.

Returns:
  To-do items with type ('submitting' = needs submission, 'grading' = needs grading),
  assignment name, course_id, due_at, and points_possible.

Examples:
  - "What do I need to do in Canvas?" → use this tool
  - "What's on my Canvas to-do list?" → use this tool`,
    inputSchema: z.object({
      include_ungraded_quizzes: z
        .boolean()
        .default(true)
        .describe("Include quiz to-do items (default: true)"),
      response_format: z.nativeEnum(Fmt).default(Fmt.Markdown),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const queryParams: Record<string, unknown> = { per_page: 50 };
      if (params.include_ungraded_quizzes) {
        queryParams["include[]"] = "ungraded_quizzes";
      }

      const result = await canvas.getPaginated<Record<string, unknown>>(
        "/users/self/todo_items",
        queryParams
      );

      if (!result.items.length) {
        return { content: [{ type: "text", text: "Your Canvas to-do list is empty!" }] };
      }

      const todos = result.items.map((t) => {
        const a = t.assignment as Record<string, unknown> | undefined;
        return {
          type: t.type,
          context_type: t.context_type,
          course_id: t.course_id,
          assignment_id: a?.id ?? null,
          assignment_name: a?.name ?? null,
          due_at: a?.due_at ?? null,
          points_possible: a?.points_possible ?? null,
          html_url: t.html_url,
        };
      });

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(todos, null, 2)) }],
          structuredContent: { todos },
        };
      }

      const lines = [`# My Canvas To-Do List (${todos.length} items)`, ""];
      for (const t of todos) {
        const name = t.assignment_name ?? "Unknown item";
        const due = fmtDate(t.due_at as string | null);
        const pts = t.points_possible != null ? `${t.points_possible} pts` : "—";
        lines.push(`### ${name}`);
        lines.push(`- **Type**: ${t.type} | **Due**: ${due} | **Points**: ${pts}`);
        lines.push(`- **Course ID**: ${t.course_id ?? "—"}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: canvas_get_upcoming_events
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_get_upcoming_events",
  {
    title: "Get Upcoming Calendar Events",
    description: `Get upcoming Canvas calendar events and assignment due dates from the student view.

No required parameters. Returns events Canvas considers "upcoming" for your account.

Returns:
  Events and assignment due dates with title, start_at, context_code, type,
  and html_url to view in Canvas.

Examples:
  - "What's on my Canvas calendar?" → use this tool
  - "What's coming up this week in Canvas?" → use this tool`,
    inputSchema: z.object({
      response_format: z.nativeEnum(Fmt).default(Fmt.Markdown),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const result = await canvas.getPaginated<Record<string, unknown>>(
        "/users/self/upcoming_events",
        { per_page: 50 }
      );

      if (!result.items.length) {
        return { content: [{ type: "text", text: "No upcoming events on your Canvas calendar." }] };
      }

      const events = result.items.map((e) => ({
        id: e.id,
        title: e.title,
        type: e.type,
        start_at: e.start_at,
        end_at: e.end_at,
        context_code: e.context_code,
        html_url: e.html_url,
      }));

      if (params.response_format === Fmt.JSON) {
        return {
          content: [{ type: "text", text: truncate(JSON.stringify(events, null, 2)) }],
          structuredContent: { events },
        };
      }

      const lines = [`# Upcoming Events (${events.length})`, ""];
      for (const e of events) {
        lines.push(`### ${e.title}`);
        lines.push(`- **When**: ${fmtDate(e.start_at as string | null)}`);
        lines.push(`- **Type**: ${e.type ?? "—"} | **Context**: ${e.context_code ?? "—"}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: truncate(lines.join("\n")) }] };
    } catch (err) {
      return { content: [{ type: "text", text: handleApiError(err) }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Canvas Student MCP Server running via stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
