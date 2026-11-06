require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 5000;
const EMPLOYEE_NAME = "Yasaswini";
const EMPLOYEE_DESIGNATION = "Talent Forge Associate";
const EMPLOYEE_EMAIL = process.env.EMPLOYEE_EMAIL;
const EXECUTIVE_EMAIL = "santhan@alphaauron.com";
const SALES_PAGE_URL = process.env.SALES_PAGE_URL || "https://alphaauron.com/talent-forge";
const ADMIN_DASHBOARD_URL = process.env.ADMIN_DASHBOARD_URL || "https://alphaauron.com/#admin";
const YASASWINI_DASHBOARD_URL = process.env.YASASWINI_DASHBOARD_URL || ADMIN_DASHBOARD_URL.replace(/#admin$/i, "#yasaswini");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LEAD_STATUSES = ["New Enquiry", "Contacted", "Follow-up", "Enrolled", "Not Interested"];

let db;
let transporter;

function requiredEnv() {
  const missing = ["EMAIL_USER", "EMAIL_PASS", "EMPLOYEE_EMAIL", "SESSION_SECRET",
    "YASASWINI_USERNAME", "YASASWINI_PASSWORD", "ADMIN_USERNAME", "ADMIN_PASSWORD"].filter(k => !process.env[k]);
  if (missing.length) throw new Error("Missing required .env values: " + missing.join(", "));
  if (process.env.SESSION_SECRET.length < 16) throw new Error("SESSION_SECRET must be at least 16 characters.");
}

// ---------- Login / session helpers (no extra dependencies) ----------
const sha = v => crypto.createHash("sha256").update(String(v)).digest();
function matches(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
function sign(data) { return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(data).digest("base64url"); }
function makeToken(role, name) {
  const body = Buffer.from(JSON.stringify({ role, name, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return body + "." + sign(body);
}
function readToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function requireAuth(roles) {
  return (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    const session = m && readToken(m[1]);
    if (!session) return res.status(401).json({ message: "Please sign in to continue." });
    if (!roles.includes(session.role)) return res.status(403).json({ message: "You do not have access to this area." });
    req.session = session;
    next();
  };
}
const loginAttempts = new Map();
function loginThrottled(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.reset < now) { loginAttempts.set(ip, { count: 0, reset: now + 15 * 60 * 1000 }); return false; }
  return rec.count >= 8;
}
function safe(value) {
  return String(value ?? "").trim().replace(/[<>]/g, "");
}
function emailText(lead, dashboardUrl) {
  return `New Talent Forge Membership Enquiry

Lead ID: ${lead.leadId}
Full Name: ${lead.fullName}
Email Address: ${lead.email}
Mobile Number: ${lead.phone}
Professional Category: ${lead.category}
Primary Skills: ${lead.skills}
Experience Level: ${lead.experience}
Current Status: ${lead.currentStatus}
Preferred Membership Duration: ${lead.duration || "Not specified"}
Membership Level of Interest: ${lead.plan || "Not specified"}
Additional Questions: ${lead.message || "None"}
Assigned Employee: ${EMPLOYEE_NAME}
Employee Designation: ${EMPLOYEE_DESIGNATION}
Submission Date and Time: ${lead.submittedAt}
Lead Source: ${lead.leadSource}
Campaign Source: ${lead.campaignSource}

View the complete lead in the Dashboard:
${dashboardUrl}

This is an automated notification from the Talent Forge membership enquiry system.`;
}
function emailHtml(lead, dashboardUrl) {
  const fields = [
    ["Lead ID",lead.leadId],["Full Name",lead.fullName],["Email Address",lead.email],
    ["Mobile Number",lead.phone],["Professional Category",lead.category],["Primary Skills",lead.skills],
    ["Experience Level",lead.experience],["Current Status",lead.currentStatus],
    ["Preferred Membership Duration",lead.duration || "Not specified"],
    ["Membership Level",lead.plan || "Not specified"],["Additional Questions",lead.message || "None"],
    ["Assigned Employee",EMPLOYEE_NAME],["Employee Designation",EMPLOYEE_DESIGNATION],
    ["Submission Date and Time",lead.submittedAt],["Lead Source",lead.leadSource],
    ["Campaign Source",lead.campaignSource]
  ];
  return `<div style="font-family:Arial,sans-serif;color:#222;max-width:720px;margin:auto"><h2 style="color:#b91c1c">New Talent Forge Membership Enquiry</h2><table style="border-collapse:collapse;width:100%">${fields.map(([k,v])=>`<tr><td style="padding:10px;border:1px solid #ddd;background:#f7f7f7;font-weight:bold;width:38%">${k}</td><td style="padding:10px;border:1px solid #ddd">${safe(v)||"—"}</td></tr>`).join("")}</table><p style="margin-top:22px"><a href="${dashboardUrl}" style="background:#b91c1c;color:#fff;padding:12px 18px;text-decoration:none;border-radius:6px">View Lead in Dashboard</a></p><p style="font-size:12px;color:#777">Automated notification from Talent Forge.</p></div>`;
}
async function sendWithLog(leadId, kind, mailOptions) {
  try {
    await transporter.sendMail(mailOptions);
    await db.run("INSERT INTO email_logs(lead_id,email_type,status,created_at) VALUES(?,?,?,?)",leadId,kind,"sent",new Date().toISOString());
    return true;
  } catch (error) {
    console.error(`${kind} email failed for ${leadId}:`, error.message);
    await db.run("INSERT INTO email_logs(lead_id,email_type,status,error,created_at) VALUES(?,?,?,?,?)",leadId,kind,"failed",error.message,new Date().toISOString());
    return false;
  }
}

app.post("/api/submit-lead", async (req,res) => {
  try {
    const b=req.body || {};
    // Honeypot: quietly reject automated form spam.
    if (b.website) return res.status(400).json({message:"Invalid submission."});
    const required=["fullName","email","phone","category","skills","experience","currentStatus"];
    for (const field of required) if (!safe(b[field])) return res.status(400).json({message:`${field} is required.`});
    if (b.privacyConsent !== true && b.privacyConsent !== "true") return res.status(400).json({message:"Privacy consent is required."});
    const email=safe(b.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({message:"Please enter a valid email address."});
    const phone=safe(b.phone);
    if (!/^\+?[0-9\s-]{10,16}$/.test(phone)) return res.status(400).json({message:"Please enter a valid mobile number."});

    const now=new Date();
    const stamp=now.toISOString();
    const leadId="TF-"+now.toISOString().slice(0,10).replace(/-/g,"")+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
    const lead={
      leadId,fullName:safe(b.fullName),email,phone,category:safe(b.category),skills:safe(b.skills),
      experience:safe(b.experience),currentStatus:safe(b.currentStatus),duration:safe(b.duration),
      plan:safe(b.plan),message:safe(b.message),assignedEmployee:EMPLOYEE_NAME,
      employeeDesignation:EMPLOYEE_DESIGNATION,employeeEmail:EMPLOYEE_EMAIL,
      leadSource:safe(b.tracking?.leadSource)||"Direct",campaignSource:safe(b.tracking?.campaignSource)||"Not specified",
      submittedAt:stamp,leadStatus:"New Enquiry"
    };

    // Save first. Emails are attempted only after the database commit succeeds.
    await db.run(`INSERT INTO leads
      (lead_id,full_name,email,phone,category,skills,experience,current_status,duration,plan,message,
       assigned_employee,employee_designation,lead_source,campaign_source,submitted_at,lead_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      lead.leadId,lead.fullName,lead.email,lead.phone,lead.category,lead.skills,lead.experience,
      lead.currentStatus,lead.duration,lead.plan,lead.message,lead.assignedEmployee,
      lead.employeeDesignation,lead.leadSource,lead.campaignSource,lead.submittedAt,lead.leadStatus
    );

    // Emails run in the background after the save, so the visitor sees the success
    // animation immediately. Every result (sent/failed) is written to email_logs.
    const sendEmails = async () => {
    // Notification to Yasaswini.
    await sendWithLog(leadId,"employee_notification",{
      from:process.env.EMAIL_USER,to:EMPLOYEE_EMAIL,
      subject:`New Talent Forge Membership Enquiry — ${leadId}`,
      text:emailText(lead,YASASWINI_DASHBOARD_URL),html:emailHtml(lead,YASASWINI_DASHBOARD_URL)
    });
    // Mandatory executive notification.
    await sendWithLog(leadId,"executive_notification",{
      from:process.env.EMAIL_USER,to:EXECUTIVE_EMAIL,
      subject:`New Talent Forge Membership Enquiry — ${leadId}`,
      text:emailText(lead,ADMIN_DASHBOARD_URL),html:emailHtml(lead,ADMIN_DASHBOARD_URL)
    });
    // Acknowledgement to visitor only after successful database save.
    const visitorText=`Hello ${lead.fullName},

Thank you for expressing your interest in Talent Forge, operated by Alpha Auron Private Limited.

We have successfully received your membership enquiry.

Our representative, ${EMPLOYEE_NAME}, ${EMPLOYEE_DESIGNATION}, will review your enquiry and contact you regarding the next steps.

You can also explore our membership information, available plans, pricing, durations, benefits, and enrolment details through the link below.

Explore Talent Forge Membership Details:
${SALES_PAGE_URL}

Your Enquiry Reference ID: ${leadId}

Thank you for your interest in Alpha Auron Talent Forge.

Regards,
Talent Forge Team
Alpha Auron Private Limited`;
    const visitorHtml=`<div style="font-family:Arial,sans-serif;line-height:1.7;color:#222;max-width:640px;margin:auto"><h2 style="color:#b91c1c">Thank You for Your Interest in Talent Forge!</h2><p>Hello ${safe(lead.fullName)},</p><p>Thank you for expressing your interest in Talent Forge, operated by Alpha Auron Private Limited.</p><p>We have successfully received your membership enquiry.</p><p>Our representative, ${EMPLOYEE_NAME}, ${EMPLOYEE_DESIGNATION}, will review your enquiry and contact you regarding the next steps.</p><p>You can also explore our membership information, available plans, pricing, durations, benefits, and enrolment details through the link below.</p><p><a href="${SALES_PAGE_URL}" style="display:inline-block;background:#b91c1c;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Explore Talent Forge Membership Details</a></p><p><b>Your Enquiry Reference ID:</b> ${leadId}</p><p>Thank you for your interest in Alpha Auron Talent Forge.</p><p>Regards,<br>Talent Forge Team<br>Alpha Auron Private Limited</p></div>`;
    await sendWithLog(leadId,"prospect_acknowledgement",{
      from:process.env.EMAIL_USER,to:lead.email,
      subject:"Thank You for Your Interest in Talent Forge!",
      text:visitorText,html:visitorHtml
    });

    };
    sendEmails().catch(err => console.error("Email workflow error for "+leadId+":", err.message));

    return res.status(201).json({message:"Enquiry saved successfully.",leadId});
  } catch(error) {
    console.error("Lead submission error:",error);
    return res.status(500).json({message:"We could not save your enquiry. Please try again."});
  }
});

// ---------- Login + dashboard API ----------
const ACCOUNTS = () => ({
  yasaswini: { username: process.env.YASASWINI_USERNAME, password: process.env.YASASWINI_PASSWORD, name: "Yasaswini" },
  admin: { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, name: "Admin" }
});

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip || "unknown";
  if (loginThrottled(ip)) return res.status(429).json({ message: "Too many attempts. Please try again in 15 minutes." });
  const { role, username, password } = req.body || {};
  const account = Object.prototype.hasOwnProperty.call(ACCOUNTS(), role) ? ACCOUNTS()[role] : null;
  // Always compare both values so timing does not reveal which one was wrong.
  const ok = account && matches(username || "", account.username) & matches(password || "", account.password);
  if (!ok) {
    const rec = loginAttempts.get(ip); if (rec) rec.count++;
    return res.status(401).json({ message: "Invalid username or password." });
  }
  loginAttempts.delete(ip);
  res.json({ token: makeToken(role, account.name), role, name: account.name });
});

app.get("/api/dashboard/leads", requireAuth(["yasaswini", "admin"]), async (req, res) => {
  try {
    const leads = req.session.role === "admin"
      ? await db.all("SELECT * FROM leads ORDER BY id DESC LIMIT 2000")
      : await db.all("SELECT * FROM leads WHERE assigned_employee = ? ORDER BY id DESC LIMIT 2000", EMPLOYEE_NAME);
    res.json({ name: req.session.name, role: req.session.role, leads });
  } catch (error) {
    console.error("Dashboard leads error:", error);
    res.status(500).json({ message: "Could not load enquiries." });
  }
});

app.get("/api/dashboard/email-logs", requireAuth(["admin"]), async (req, res) => {
  try {
    const logs = await db.all(`SELECT e.id,e.lead_id,e.email_type,e.status,e.error,e.created_at,l.full_name
      FROM email_logs e LEFT JOIN leads l ON l.lead_id=e.lead_id ORDER BY e.id DESC LIMIT 1000`);
    res.json({ logs });
  } catch (error) {
    console.error("Dashboard email-log error:", error);
    res.status(500).json({ message: "Could not load email log." });
  }
});

app.patch("/api/dashboard/leads/:leadId/status", requireAuth(["yasaswini", "admin"]), async (req, res) => {
  try {
    const status = String((req.body || {}).status || "");
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status." });
    const result = await db.run("UPDATE leads SET lead_status=? WHERE lead_id=?", status, req.params.leadId);
    if (!result.changes) return res.status(404).json({ message: "Enquiry not found." });
    res.json({ message: "Status updated.", status });
  } catch (error) {
    console.error("Status update error:", error);
    res.status(500).json({ message: "Could not update status." });
  }
});

async function start() {
  requiredEnv();
  db=await open({filename:path.join(__dirname,"talent_forge_leads.sqlite"),driver:sqlite3.Database});
  await db.exec(`CREATE TABLE IF NOT EXISTS leads(
    id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id TEXT UNIQUE NOT NULL,full_name TEXT NOT NULL,email TEXT NOT NULL,
    phone TEXT NOT NULL,category TEXT NOT NULL,skills TEXT NOT NULL,experience TEXT NOT NULL,current_status TEXT NOT NULL,
    duration TEXT,plan TEXT,message TEXT,assigned_employee TEXT,employee_designation TEXT,lead_source TEXT,
    campaign_source TEXT,submitted_at TEXT,lead_status TEXT)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS email_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id TEXT NOT NULL,email_type TEXT NOT NULL,status TEXT NOT NULL,
    error TEXT,created_at TEXT NOT NULL,FOREIGN KEY(lead_id) REFERENCES leads(lead_id))`);
  transporter=nodemailer.createTransport({host:process.env.SMTP_HOST||"smtp.gmail.com",port:Number(process.env.SMTP_PORT||465),secure:(process.env.SMTP_SECURE||"true")==="true",auth:{user:process.env.EMAIL_USER,pass:process.env.EMAIL_PASS}});
  await transporter.verify();
  app.listen(PORT,()=>console.log(`Talent Forge server running at http://localhost:${PORT}`));
}
start().catch(err=>{console.error("Server startup failed:",err.message);process.exit(1);});