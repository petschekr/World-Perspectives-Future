import Promise = require("bluebird");
var fs = Promise.promisifyAll(require("fs"));
import common = require("../common");
var db = common.db;
import express = require("express");
import bodyParser = require("body-parser");
var postParser = bodyParser.json();
var router = express.Router();
var neo4j = require("neo4j");
import moment = require("moment");

var authenticateCheck = common.authenticateMiddleware;
var registeredCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated) {
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(403).send("You must be logged in to register");
		}
	}
	else if (response.locals.user.registered) {
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(409).send("You have already registered");
		}
	}
	else {
		next();
	}
};
router.use(authenticateCheck, registeredCheck);

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

function IgnoreError() {
    var temp = Error.apply(this, arguments);
    temp.name = this.name = "IgnoreError";
    this.stack = temp.stack;
    this.message = temp.message;
}
IgnoreError.prototype = Object.create(Error.prototype, {
    constructor: {
        value: IgnoreError,
        writable: true,
        configurable: true
    }
});

router.route("/").get(function (request, response) {
	db.cypherAsync({
		query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL RETURN c"
	}).then(function (result) {
		var registrationOpen: boolean = result[0].c.properties.registrationOpen;
		if (registrationOpen) {
			return fs.readFileAsync("pages/register.html", "utf8");
		}
		else {
			return fs.readFileAsync("pages/registrationclosed.html", "utf8");
		}
	}).then(function (html: string) {
		response.send(html);
	}).catch(common.handleError.bind(response));
});
router.route("/sessions").get(function (request, response) {
    db.cypherAsync({
		query: "MATCH (item:ScheduleItem {editable: true}) RETURN item.title AS title, item.start AS start, item.end AS end ORDER BY item.start"
	}).then(function (results: any[]) {
		results = results.map(function (item) {
			return {
				"title": item.title,
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
			};
		});
		response.json(results);
	}).catch(common.handleError.bind(response));
});
router.route("/sessions/:time")
	.get(function (request, response) {
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
	})
	.post(postParser, function (request, response) {
		var {slug}: { slug: string } = request.body;
		var {time}: { time: string } = request.params;
		var intendedSession = null;
		var isOwn = false;
		// 1: Get this specific session and check for existance, time, and capacity
		// 2: Determine if this user presents a session at this time. If so, they must register for it.
		// 3: Determine if this user moderates a session at this time. If so, they must register for it.
		Promise.all([
			db.cypherAsync({
				"query": "MATCH (s:Session {slug: {slug}, startTime: {time}}) RETURN s.startTime AS start, s.capacity AS capacity, s.attendees AS attendees",
				"params": {
					slug: slug,
					time: time
				}
			}),
			db.cypherAsync({
				"query": "MATCH (user:User {username: {username}})-[r:PRESENTS]->(s:Session {startTime: {time}}) RETURN s.slug AS slug, s.title AS title",
				"params": {
					username: response.locals.user.username,
					time: time
				}
			}),
			db.cypherAsync({
				"query": "MATCH (user:User {username: {username}})-[r:MODERATES]->(s:Session {startTime: {time}}) RETURN s.slug AS slug, s.title AS title",
				"params": {
					username: response.locals.user.username,
					time: time
				}
			}),
			db.cypherAsync({
				query: "MATCH (user:User {username: {username}}) RETURN user.hasFree AS hasFree, user.timeOfFree AS timeOfFree",
				params: {
					username: response.locals.user.username
				}
			})
		]).spread(function (sessions, presentations, moderations, userFreeInfo) {
			userFreeInfo = userFreeInfo[0];
			if (presentations.length > 0 && presentations[0].slug !== slug) {
				response.json({ "success": false, "message": `You must select the session that you are presenting during this time period: "${presentations[0].title}"` });
				return Promise.reject(new IgnoreError());
			}
			if (moderations.length > 0 && moderations[0].slug !== slug) {
				response.json({ "success": false, "message": `You must select the session that you are moderating during this time period: "${moderations[0].title}"` });
				return Promise.reject(new IgnoreError());
			}
			if ((presentations.length > 0 && presentations[0].slug === slug) || (moderations.length > 0 && moderations[0].slug === slug)) {
				isOwn = true;
			}

			if (slug !== "free") {
				if (sessions.length !== 1) {
					response.json({ "success": false, "message": "Invalid session ID" });
					return Promise.reject(new IgnoreError());
				}
				var session = sessions[0];
				intendedSession = session;
				if (session.start !== time) {
					response.json({ "success": false, "message": "Session has mismatching start time" });
					return Promise.reject(new IgnoreError());
				}
				if (session.attendees >= session.capacity) {
					response.json({ "success": false, "message": "There are too many people in that session. Please choose another." });
					return Promise.reject(new IgnoreError());
				}
				if (userFreeInfo.hasFree && userFreeInfo.timeOfFree === time) {
					return db.cypherAsync({
						"query": "MATCH (user:User {username: {username}}) REMOVE user.hasFree, user.timeOfFree",
						"params": {
							username: response.locals.user.username
						}
					});
				}
				else {
					return Promise.resolve();
				}
			}
			else {
				if (userFreeInfo.hasFree && userFreeInfo.timeOfFree !== time) {
					response.json({ "success": false, "message": "You may select only one free" });
					return Promise.reject(new IgnoreError());
				}
				else {
					return Promise.resolve();
				}
			}
		}).then(function () {
			// Now check if deregistration needs to happen and remove the relationship and decrement the number of attendees (the user selected a different session previously and has changed their mind)
			return db.cypherAsync({
				"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session {startTime: {time}}) SET s.attendees = s.attendees - 1 DELETE r RETURN s.slug AS slug, s.attendees AS attendees",
				"params": {
					username: response.locals.user.username,
					time: time
				}
			});
		}).then(function (results: {slug: string, attendees: number}[]) {
			// Notify via WebSocket of newly available spaces
			results.forEach(function (deletedSession) {
				common.io.emit("availability", {
					"slug": deletedSession.slug,
					"attendees": deletedSession.attendees
				});
			});
			if (isOwn) {
				// The attendance isn't increased if the user is a presenter or moderator of the selected session
				return db.cypherAsync({
					query: `
							MATCH (user:User {username: {username}})
							MATCH (session:Session {slug: {slug}})
							CREATE (user)-[r:ATTENDS]->(session)`,
					params: {
						username: response.locals.user.username,
						slug: slug
					}
				});
			}
			else {
				if (intendedSession !== null) {
					// Notify via WebSocket of the intention to register
					common.io.emit("availability", {
						"slug": slug,
						"attendees": intendedSession.attendees + 1
					});
					return db.cypherAsync({
						query: `
								MATCH (user:User {username: {username}})
								MATCH (session:Session {slug: {slug}})
								CREATE (user)-[r:ATTENDS]->(session)
								SET session.attendees = session.attendees + 1`,
						params: {
							username: response.locals.user.username,
							slug: slug
						}
					});
				}
				else {
					// Register for a free
					return db.cypherAsync({
						query: "MATCH (user:User {username: {username}}) SET user.hasFree = true, user.timeOfFree = {time}",
						params: {
							username: response.locals.user.username,
							time: time
						}
					});
				}
			}
		}).then(function () {
			response.json({ "success": true, "message": "Successfully registered for session" });
		}).catch(IgnoreError, function () {
			// Response has already been handled if this error is thrown
		}).catch(common.handleError.bind(response));
	});
router.route("/done").post(function (request, response) {
	// 1: Get all registered sessions
	// 2: Get the number of editable periods to ensure that all have been customized
	// 3: Get the user's free period data
	Promise.all([
		db.cypherAsync({
			"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.type AS type",
			"params": {
				username: response.locals.user.username
			}
		}),
		db.cypherAsync({
			"query": "MATCH (item:ScheduleItem {editable: true}) RETURN count(item) AS periods",
		}),
		db.cypherAsync({
			query: "MATCH (user:User {username: {username}}) RETURN user.hasFree AS hasFree, user.timeOfFree AS timeOfFree",
			params: {
				username: response.locals.user.username
			}
		})
	]).spread(function (results, periods, userFreeInfo) {
		periods = periods[0].periods;
		userFreeInfo = userFreeInfo[0];
		var hasSelectedPanel = false;
		var hasSelectedSession = false;
		for (let result of results) {
			if (result.type === "Global session" || result.type === "Science session") {
				hasSelectedSession = true;
				continue;
			}
			if (result.type === "Panel") {
				hasSelectedPanel = true;
				continue;
			}
		}
		if (!hasSelectedPanel) {
			response.json({ "success": false, "message": "You must select at least one panel" });
			return Promise.reject(new IgnoreError());
		}
		if (!hasSelectedSession) {
			response.json({ "success": false, "message": "You must select at least one global studies or science session" });
			return Promise.reject(new IgnoreError());
		}
		if (userFreeInfo.hasFree) {
			periods--;
		}
		if (results.length < periods) {
			response.json({ "success": false, "message": "Your registration isn't yet completed" });
			return Promise.reject(new IgnoreError());
		}

		return db.cypherAsync({
			"query": "MATCH (user:User {username: {username}}) SET user.registered = true",
			"params": {
				username: response.locals.user.username
			}
		});
	}).then(function (results) {
		response.json({ "success": true, "message": "Registration completed successfully" });
	}).catch(IgnoreError, function () {
		// Response has already been handled if this error is thrown
	}).catch(common.handleError.bind(response));
});

export = router;