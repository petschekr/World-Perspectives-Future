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
		query: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, teacher: {teacher}, admin: {admin}, code: {code}})",
		params: {
			name: testUser.name,
			username: testUser.username,
			registered: registered,
			teacher: teacher,
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
describe("Admin endpoints", () => {
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
	it("Unauthorized GET /", (done) => {
		request(app)
			.get("/admin")
			.set("Cookie", testUser.cookie)
			.redirects(0)
			.expect(302)
			.expect("location", "/")
			.end(done);
	});
	it("Authorized GET /", (done) => {
		removeTestUser(function () {
			insertTestUser(false, false, true, function () {
				request(app)
					.get("/admin")
					.set("Cookie", testUser.cookie)
					.redirects(0)
					.expect(200)
					.expect("Content-Type", /html/)
					.end(done);
			});
		});
	});
	it("GET /user");
	it("POST /user");
	it("GET /user/username");
	it("PUT /user/username");
	it("DELETE /user/username");
	it("GET /schedule");
	it("PATCH /schedule");
	it("GET /session");
	it("POST /session");
	it("GET /session/:slug");
	it("DELETE /session/:slug");
});