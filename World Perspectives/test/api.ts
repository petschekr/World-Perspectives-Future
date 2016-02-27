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

function signCookie(val, secret): string {
	// Simplified from node-cookie-signature
	var signature = crypto.createHmac("sha256", secret).update(val).digest("base64").replace(/\=+$/, "");
	return val + "." + signature;
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
	var testUser = {
		"name": "Test User",
		"username": "usertest",
		"code": crypto.randomBytes(16).toString("hex"),
		"cookie": null
	};
	before(function (done) {
		// Insert a test user into the database
		testUser.cookie = "username=s" + encodeURIComponent(":" + signCookie(testUser.username, common.keys.cookieSecret));
		db.cypher({
			query: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, teacher: {teacher}, admin: {admin}, code: {code}})",
			params: {
				name: testUser.name,
				username: testUser.username,
				registered: false,
				teacher: false,
				admin: false,
				code: testUser.code
			}
		}, done);
	});
	after(function (done) {
		// Remove test user from the database
		db.cypher({
			query: "MATCH (user:User {username: {username}}) DELETE user",
			params: {
				username: testUser.username
			}
		}, done);
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
	it("Invalid GET /login/:code");
	it("Valid unregistered GET /login/:code");
	it("Valid registered GET /login/:code");
});
describe("Admin endpoints", () => {

});