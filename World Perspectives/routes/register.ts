import Promise = require("bluebird");
var fs = Promise.promisifyAll(require("fs"));
import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();
var neo4j = require("neo4j");
import moment = require("moment");

var authenticateCheck = common.authenticateMiddleware;
var registeredCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated || response.locals.user.registered) {
		response.redirect("/");
	}
	else {
		next();
	}
};
router.use(authenticateCheck, registeredCheck);

router.route("/").get(function (request, response) {
    fs.readFileAsync("pages/register.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});

export = router;