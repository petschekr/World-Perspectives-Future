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

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

router.route("/").get(function (request, response) {
    fs.readFileAsync("pages/register.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});
router.route("/sessions").get(function (request, response) {
    db.cypherAsync({
		query: "MATCH (item:ScheduleItem) RETURN item.start AS start, item.end AS end, item.editable AS editable ORDER BY item.start"
	}).then(function (results) {
		// Get and return unique times
		var times = [];
		for (var item of results) {
			if (!item.editable)
				continue;
			let alreadyExists: boolean = false;
			for (var previousInsertion of times) {
				if (previousInsertion.start.raw === item.start) {
					alreadyExists = true;
					break;
				}
			}
			if (alreadyExists)
				continue;
			times.push({
				"start": {
					"raw": item.start,
					"formatted": moment(item.start).format(timeFormat),
					"url": `/register/sessions/${encodeURIComponent(item.start)}`
				},
				"end": {
					"raw": item.end,
					"formatted": moment(item.end).format(timeFormat),
					"url": `/register/sessions/${encodeURIComponent(item.end)}`
				}
			});
		}
		response.json(times);
	}).catch(common.handleError.bind(response));
});
router.route("/sessions/:time").get(function (request, response) {
	var startTime = request.params.time;
    db.cypherAsync({
		query: `MATCH (s:Session {startTime: { startTime }}) RETURN
			s.title AS title,
			s.slug AS slug,
			s.description AS description,
			s.type AS type,
			s.location AS location,
			s.capacity AS capacity,
			s.attendees AS attendees,
			s.startTime AS startTime,
			s.endTime AS endTime
			ORDER BY lower(s.title)`,
		params: {
			startTime: startTime
		}
	}).then(function (results) {
		return Promise.map(results, function (session: any) {
			return db.cypherAsync({
				queries: [{
					query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
					params: {
						slug: session.slug
					}
				}, {
					query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name",
					params: {
						slug: session.slug
					}
				}]
			}).then(function (sessionRelationships) {
				return {
					"title": {
						"formatted": session.title,
						"slug": session.slug
					},
					"description": session.description,
					"type": session.type,
					"location": session.location,
					"capacity": {
						"total": session.capacity,
						"filled": session.attendees
					},
					"time": {
						"start": {
							"raw": session.startTime,
							"formatted": moment(session.startTime).format(timeFormat)
						},
						"end": {
							"raw": session.endTime,
							"formatted": moment(session.endTime).format(timeFormat)
						},
						"date": moment(session.startTime).format(dateFormat)
					},
					"presenters": sessionRelationships[0],
					"moderator": (sessionRelationships[1].length !== 0) ? sessionRelationships[1][0] : null
				};
			});
		});
	})
	.then(function (sessions) {
		response.json(sessions);
	})
	.catch(common.handleError.bind(response));
});

export = router;