import assert = require("assert");
import chai = require("chai");
import request = require("supertest");
var expect = chai.expect;

import app = require("../server");
declare var describe: any, it: any;

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
});