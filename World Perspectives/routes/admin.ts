import fs = require("fs");
import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();

interface User extends common.User { };

var authenticateCheck = common.authenticateMiddleware;
var adminCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated || !response.locals.user.admin) {
		response.redirect("/");
	}
	else {
		next();
	}
};

router.route("/").get(authenticateCheck, adminCheck, function (request, response) {
    fs.readFile("pages/admin.html", "utf8", function (err: Error, html: string) {
		if (err) {
			return common.handleError(err);
		}
		response.send(html);
	});
});

export = router;