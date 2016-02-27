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
});