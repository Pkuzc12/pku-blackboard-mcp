import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMaterialPage } from "../src/materials.js";

test("parses content files, item text, child folders, and next page links", () => {
  const html = `
    <ul id="content_listContainer">
      <li class="listElement">
        <h3>Week 1 slides</h3>
        <div class="vtbegenerated">Read before class &amp; bring questions.</div>
        <a href="/bbcswebdav/pid-1-dt-content-rid-2_1/xid-2_1">slides.pdf</a>
        <a href="/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1">Folder A</a>
      </li>
    </ul>
    <a title="下一页" href="/webapps/blackboard/content/listContent.jsp?page=2">Next</a>
  `;

  const parsed = parseMaterialPage({
    html,
    pageUrl: "https://course.pku.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=_1_1",
    section: "Materials",
    type: "content",
  });

  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].title, "slides.pdf");
  assert.equal(parsed.files[0].url, "https://course.pku.edu.cn/bbcswebdav/pid-1-dt-content-rid-2_1/xid-2_1");
  assert.equal(parsed.texts.length, 1);
  assert.equal(parsed.texts[0].title, "Week 1 slides");
  assert.match(parsed.texts[0].text, /Read before class & bring questions/);
  assert.equal(parsed.childLinks.length, 2);
});

test("parses announcement headings and details", () => {
  const html = `
    <h3>Exam notice</h3>
    <div class="details"><p>The exam is moved to room 101.</p></div>
  `;

  const parsed = parseMaterialPage({
    html,
    pageUrl: "https://course.pku.edu.cn/webapps/blackboard/execute/announcement",
    section: "Announcements",
    type: "announcements",
  });

  assert.equal(parsed.files.length, 0);
  assert.equal(parsed.texts.length, 1);
  assert.equal(parsed.texts[0].title, "Exam notice");
  assert.equal(parsed.texts[0].type, "announcement");
  assert.match(parsed.texts[0].text, /room 101/);
});

test("parses scoped grade text", () => {
  const html = `
    <div id="grades_wrapper">
      <table><tr><th>Quiz</th><td>95</td></tr></table>
    </div>
  `;

  const parsed = parseMaterialPage({
    html,
    pageUrl: "https://course.pku.edu.cn/webapps/bb-mygrades-BBLEARN",
    section: "Grades",
    type: "grades",
  });

  assert.equal(parsed.texts.length, 1);
  assert.equal(parsed.texts[0].type, "grades");
  assert.match(parsed.texts[0].text, /Quiz/);
  assert.match(parsed.texts[0].text, /95/);
});
