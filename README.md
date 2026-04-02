# Canvas Student MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives Claude direct access to your Canvas LMS account — built for students.

The official Canvas MCP never exposed the tools students actually need. This one does.

## Tools

| Tool | What it does |
|---|---|
| `canvas_list_courses` | List enrolled courses with optional grade data |
| `canvas_get_my_grades` | Current grade and score across all active courses |
| `canvas_list_assignments` | Assignments by course, filtered by bucket (upcoming, overdue, etc.) |
| `canvas_get_assignment_grade` | Score, grade, and instructor feedback on a specific submission |
| `canvas_get_course_submissions` | All submissions for a course with grades |
| `canvas_list_course_files` | Browse files in a course |
| `canvas_get_file_url` | Get a direct download URL for any course file |
| `canvas_get_announcements` | Professor announcements across one or more courses |
| `canvas_get_todo_items` | Canvas built-in student to-do list |
| `canvas_get_upcoming_events` | Upcoming calendar events and assignment due dates |

## Setup

### 1. Get a Canvas API token

In Canvas: **Account → Settings → New Access Token**

### 2. Install and build

```bash
git clone https://github.com/YOUR_USERNAME/canvas-student-mcp-server
cd canvas-student-mcp-server
npm install
npm run build
```

### 3. Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "canvas-student": {
      "command": "node",
      "args": ["/absolute/path/to/canvas-student-mcp-server/dist/index.js"],
      "env": {
        "CANVAS_API_TOKEN": "your-token-here",
        "CANVAS_BASE_URL": "https://YOUR_SCHOOL.instructure.com"
      }
    }
  }
}
```

Replace `YOUR_SCHOOL` with your institution's Canvas subdomain (e.g. `boisestatecanvas`, `canvas.stanford`, etc.).

Restart Claude Desktop — the tools will appear automatically.

## Example prompts

- *"What are my current grades?"*
- *"What assignments do I have due this week in ACCT 201?"*
- *"Did any of my professors post announcements today?"*
- *"What's on my Canvas to-do list?"*
- *"Show me the files in my Finance course and get me the syllabus download link."*
- *"What did I get on my last essay and did the professor leave any feedback?"*

## Requirements

- Node.js 18+
- A Canvas LMS account with API token access
- Claude Desktop (or any MCP-compatible client)

## Development

```bash
npm run dev   # watch mode with tsx
npm run build # compile to dist/
```
