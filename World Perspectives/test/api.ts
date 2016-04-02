import assert = require("assert");
import crypto = require("crypto");
import chai = require("chai");
import request = require("supertest");
var expect = chai.expect;

import app = require("../server");
import common = require("../common");
var db = common.db;

declare var describe: any;
declare var it: any;
declare var before: (func: (done?: () => void) => void) => void;
declare var after: (func: (done?: () => void) => void) => void;
declare var beforeEach: (func: (done?: () => void) => void) => void;
declare var afterEach: (func: (done?: () => void) => void) => void;

function signCookie (val, secret): string {
	// Simplified from node-cookie-signature
	var signature = crypto.createHmac("sha256", secret).update(val).digest("base64").replace(/\=+$/, "");
	return val + "." + signature;
}
var testUser: any = {
	"name": "Test User",
	"username": "usertest",
	"code": crypto.randomBytes(16).toString("hex"),
};
testUser.cookie = "username=s" + encodeURIComponent(":" + signCookie(testUser.username, common.keys.cookieSecret));
function insertTestUser (registered: boolean = false, teacher: boolean = false, admin: boolean = false, done: (err?: Error) => void): void {
	db.cypher({
		query: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
		params: {
			name: testUser.name,
			username: testUser.username,
			registered: registered,
			type: teacher ? common.UserType.Teacher : common.UserType.Student,
			admin: admin,
			code: testUser.code
		}
	}, done);
}
function removeTestUser(done: (err?: Error) => void): void {
	db.cypher({
		query: "MATCH (user:User {username: {username}}) DELETE user",
		params: {
			username: testUser.username
		}
	}, done);
}

describe("Main endpoints", () => {
    it("GET /", (done) => {
        request(app)
			.get("/")
			.expect(200)
			.expect("Content-Type", /html/)
			.end(done);
    });
	it("GET /about", (done) => {
		request(app)
			.get("/about")
			.expect(200)
			.expect("Content-Type", /html/)
			.end(done);
    });
	it("GET /print", (done) => {
		request(app)
			.get("/print")
			.expect(200)
			.expect("Content-Type", /html/)
			.end(done);
    });
});
describe("Data endpoints", () => {
	it("GET /schedule", (done) => {
		request(app)
			.get("/data/schedule")
			.expect(200)
			.expect("Content-Type", /json/)
			.expect(function (response) {
				expect(response.body).to.be.an("array");
				expect(response.body).to.have.length.above(0);
				for (let item of response.body) {
					expect(item).to.have.all.keys(["title", "time", "location", "editable"]);
				}
			})
			.end(done);
	});
	it("GET /date", (done) => {
		request(app)
			.get("/data/date")
			.expect(200)
			.expect("Content-Type", /json/)
			.expect(function (response) {
				expect(response.body).to.be.an("object");
				expect(response.body).to.have.all.keys(["formatted"]);
				expect(response.body.formatted).to.be.a("string");
			})
			.end(done);
	});
});
describe("User endpoints", () => {
	before(function (done) {
		insertTestUser(false, false, false, done);
	});
	after(function (done) {
		removeTestUser(done);
	});
	it("Unauthenticated GET /", (done) => {
		request(app)
			.get("/user")
			.expect(403)
			.expect("Content-Type", /json/)
			.expect(function (response) {
				expect(response.body).to.have.keys("error");
			})
			.end(done);
	});
	it("Authenticated GET /", (done) => {
		expect(testUser.cookie).to.be.a("string");
		expect(testUser.cookie).to.not.be.empty;
		request(app)
			.get("/user")
			.set("Cookie", testUser.cookie)
			.expect(200)
			.expect("Content-Type", /json/)
			.expect(function (response) {
				expect(response.body).to.have.all.keys(["name", "username", "registered", "admin"]);
				expect(response.body.name).to.equal(testUser.name);
				expect(response.body.username).to.equal(testUser.username);
				expect(response.body.registered).to.be.false;
				expect(response.body.admin).to.be.false;
			})
			.end(done);
	});
	it("Invalid GET /login/:code", (done) => {
		request(app)
			.get("/user/login/abcd")
			.redirects(0)
			.expect(200)
			.expect("Content-Type", /html/)
			.end(done);
	});
	it("Valid unregistered GET /login/:code", (done) => {
		request(app)
			.get(`/user/login/${testUser.code}`)
			.redirects(0)
			.expect(302)
			.expect("set-cookie", new RegExp(`${testUser.cookie};`))
			.expect("location", "/register")
			.end(done);
	});
	it("Valid registered GET /login/:code", (done) => {
		removeTestUser(function () {
			insertTestUser(true, false, false, function () {
				request(app)
					.get(`/user/login/${testUser.code}`)
					.redirects(0)
					.expect(302)
					.expect("set-cookie", new RegExp(`${testUser.cookie};`))
					.expect("location", "/")
					.end(done);
			});
		});
	});
});
describe("Unauthenticated admin endpoints", () => {
	before(function (done) {
		insertTestUser(false, false, false, done);
	});
	after(function (done) {
		removeTestUser(done);
	});
	it("Unauthenticated GET /", (done) => {
		request(app)
			.get("/admin")
			.redirects(0)
			.expect(302)
			.expect("location", "/")
			.end(done);
	});
	it("Unauthenticated POST /", (done) => {
		request(app)
			.post("/admin")
			.redirects(0)
			.expect(403)
			.end(done);
	});
	it("Unauthorized GET /", (done) => {
		request(app)
			.get("/admin")
			.set("Cookie", testUser.cookie)
			.redirects(0)
			.expect(302)
			.expect("location", "/")
			.end(done);
	});
	it("Unauthorized POST /", (done) => {
		request(app)
			.post("/admin")
			.set("Cookie", testUser.cookie)
			.redirects(0)
			.expect(403)
			.end(done);
	});
});
describe("Admin endpoints", () => {
	before(function (done) {
		insertTestUser(false, false, true, done);
	});
	after(function (done) {
		removeTestUser(done);
	});
	it("Authorized GET /", (done) => {
		request(app)
			.get("/admin")
			.set("Cookie", testUser.cookie)
			.redirects(0)
			.expect(200)
			.expect("Content-Type", /html/)
			.end(done);
	});
	it("GET /user (pagination)", (done) => {
		request(app)
			.get("/admin/user")
			.set("Cookie", testUser.cookie)
			.expect(200)
			.expect("Content-Type", /json/)
			.expect(function (response) {
				expect(response.body).to.be.an("object");
				expect(response.body).to.have.all.keys(["info", "data"]);
				expect(response.body.info).to.be.an("object");
				expect(response.body.info).to.have.all.keys(["page", "pageSize", "total", "totalPages"]);
				expect(response.body.info.page).to.equal(1);
				expect(response.body.data).to.be.an("array");
				for (let item of response.body.data) {
					expect(item).to.have.all.keys(["username", "name", "registered", "admin", "type"]);
					expect(item.username).to.be.a("string");
					expect(item.name).to.be.a("string");
					expect(item.registered).to.be.a("boolean");
					expect(item.admin).to.be.a("boolean");
					expect(item.type).to.be.a("number");
				}
			})
			.end(done);
	});
	it("GET /user (list all users)", (done) => {
		request(app)
			.get("/admin/user?all=true")
			.set("Cookie", testUser.cookie)
			.expect(200)
			.expect("Content-Type", /json/)
			.expect(function (response) {
				expect(response.body).to.be.an("array");
				expect(response.body).to.have.length.above(0);
				for (let item of response.body) {
					expect(item).to.be.a("string");
				}
			})
			.end(done);
	});
	it("POST /user (import users from Excel file)");
	it("DELETE /user (delete all non-admin users)");

	it("GET /user/:username (get specific user)");
	it("PUT /user/:username (create user with username)");
	it("DELETE /user/:username (delete specific user");

	it("GET /session (list all sessions)");
	it("POST /session (create a new session)");

	it("GET /session/:slug (get specific session)");
	it("DELETE /session/:slug (delete specific session");

	it("GET /schedule", (done) => {
		request(app)
			.get("/admin/schedule")
			.set("Cookie", testUser.cookie)
			.expect(200)
			.expect("Content-Type", /json/)
			.expect(function (response) {
				expect(response.body).to.be.an("array");
				expect(response.body).to.have.length.above(0);
				for (let item of response.body) {
					expect(item).to.have.all.keys(["title", "time", "location", "editable"]);
				}
			})
			.end(done);
	});
	it("PATCH /schedule");
});