import Promise = require("bluebird");
var fs = Promise.promisifyAll(require("fs"));
import crypto = require("crypto");
import common = require("../common");
var db = common.db;
import express = require("express");
import bodyParser = require("body-parser");
var postParser = bodyParser.json();
var router = express.Router();
var neo4j = require("neo4j");
import moment = require("moment");
var slugMaker = require("slug");
var sendgrid = Promise.promisifyAll(require("sendgrid")(common.keys.sendgrid));
var multer = require("multer");
var uploadHandler = multer({
	"storage": multer.memoryStorage(),
	"limits": {
		"fileSize": 1000000, // 1 MB
		"files": 1,
		"fields": 0
	},
	"fileFilter": function (request, file, callback) {
		const excelMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		if (file.mimetype === excelMimeType && !!file.originalname.match("\.xlsx$")) {
			callback(null, true);
		}
		else {
			callback(null, false);
		}
	}
});
var xlsx = require("node-xlsx");

interface User extends common.User { };
const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";
function IgnoreError() {
    var temp = Error.apply(this, arguments);
    temp.name = this.name = "IgnoreError";
    this.stack = temp.stack;
    this.message = temp.message;
}
//inherit prototype using ECMAScript 5 (IE 9+)
IgnoreError.prototype = Object.create(Error.prototype, {
    constructor: {
        value: IgnoreError,
        writable: true,
        configurable: true
    }
});

var authenticateCheck = common.authenticateMiddleware;
var adminCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated || !response.locals.user.admin) {
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(403).send("Forbidden to non-admin users");
		}
	}
	else {
		next();
	}
};
router.use(authenticateCheck, adminCheck);

router.route("/").get(function (request, response) {
    fs.readFileAsync("pages/admin.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});

router.route("/user")
	.get(function (request, response) {
		if (request.query.all && request.query.all.toLowerCase() === "true") {
			// All users' names for autocomplete
			db.cypherAsync({
				query: "MATCH (user:User) RETURN user.name AS name ORDER BY last(split(user.name, \" \"))"
			}).then(function (results) {
				response.json(results.map(function (user) {
					return user.name;
				}));
			}).catch(common.handleError.bind(response));
		}
		else {
			const usersPerPage = 10;
			var page = parseInt(request.query.page, 10);
			if (isNaN(page) || page < 0) {
				page = 0;
			}
			var filter = request.query.filter;
			if (!filter)
				filter = "all";
			if (filter === "all") {
				var criteria = "";
			}
			else if (filter === "freshman") {
				var criteria = "grade: 9";
			}
			else if (filter === "sophomore") {
				var criteria = "grade: 10";
			}
			else if (filter === "junior") {
				var criteria = "grade: 11";
			}
			else if (filter === "senior") {
				var criteria = "grade: 12";
			}
			else if (filter === "admin") {
				var criteria = "admin: true";
			}
			else if (filter === "nonadmin") {
				var criteria = "admin: false";
			}
			else {
				var criteria = "type: {type}";
			}
			db.cypherAsync({
				queries: [{
					query: `MATCH (user:User {${criteria}}) RETURN user.username AS username, user.name AS name, user.email AS email, user.registered AS registered, user.admin AS admin, user.type AS type, user.code AS code ORDER BY last(split(user.name, " ")) SKIP {skip} LIMIT {limit}`,
					params: {
						skip: page * usersPerPage,
						limit: usersPerPage,
						type: common.getUserType(filter)
					}
				}, {
					query: `MATCH (user:User {${criteria}}) RETURN count(user) AS total`,
					params: {
						type: common.getUserType(filter)
					}
				}]
			}).then(function (results) {
				response.json({
					"info": {
						"page": page + 1,
						"pageSize": usersPerPage,
						"total": results[1][0].total,
						"totalPages": Math.ceil(results[1][0].total / usersPerPage)
					},
					"data": results[0].map(function (user) {
						if (!user.email) {
							user.email = `${user.username}@gfacademy.org`
						}
						return user;
					})
				});
			}).catch(common.handleError.bind(response));
		}
	})
	.post(uploadHandler.single("import"), function (request, response) {
		try {
			// CAUTION: This is a blocking method
			var data = xlsx.parse(request.file.buffer);
		}
		catch (err) {
			response.json({ "success": false, "message": "Invalid Excel file uploaded" });
			return;
		}
		if (data.length !== 2) {
			response.json({ "success": false, "message": "Please put students on the first sheet and faculty on the second" });
			return;
		}
		var queries = [];
		var emailRegEx = /^(.*?)@gfacademy.org$/i;
		// Students
		for (let i = 0; i < data[0].data.length; i++) {
			let student = data[0].data[i];
			if (student.length === 0)
				continue;
			let firstName = student[0];
			let lastName = student[1];
			let email = student[2];
			let grade = parseInt(student[3], 10);
			if ((!firstName || !lastName || !email || isNaN(grade)) && i !== 0) {
				response.json({ "success": false, "message": "Invalid format for students. Expected first name, last name, email, grade." });
				return;
			}
			var emailParsed = email.match(emailRegEx);
			// Check if there is actually an email in the email field. If not, it's probably the header
			if (!emailParsed)
				continue;
			var code = crypto.randomBytes(16).toString("hex");
			queries.push({
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}, grade: {grade}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					type: common.UserType.Student,
					admin: false,
					code: code,
					grade: grade
				}
			});
		}
		// Faculty
		for (let i = 0; i < data[1].data.length; i++) {
			let teacher = data[1].data[i];
			if (teacher.length === 0)
				continue;
			let firstName = teacher[0];
			let lastName = teacher[1];
			let email = teacher[2];
			if (!firstName || !lastName || !email) {
				response.json({ "success": false, "message": "Invalid format for faculty. Expected first name, last name, email." });
				return;
			}
			var emailParsed = email.match(emailRegEx);
			// Check if there is actually an email in the email field. If not, it's probably the header
			if (!emailParsed)
				continue;
			var code = crypto.randomBytes(16).toString("hex");
			queries.push({
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					type: common.UserType.Teacher,
					admin: false,
					code: code
				}
			});
		}
		db.cypherAsync({ queries: queries })
			.then(function (results) {
				response.json({ "success": true, "message": `${queries.length} users successfully created` });
			}).catch(neo4j.ClientError, function () {
				response.json({ "success": false, "message": "A user with an existing username can't be imported. Rolling back changes." });
			}).catch(common.handleError.bind(response));
	})
	.delete(function (request, response) {
		db.cypherAsync({
			query: "MATCH (user:User {admin: false}) DETACH DELETE user"
		}).then(function (results) {
			response.json({ "success": true, "message": "All non-admin users successfully deleted" });
		}).catch(common.handleError.bind(response));
	});
router.route("/user/:username")
	.get(function (request, response) {
		var username = request.params.username;
		db.cypherAsync({
			query: "MATCH (user:User {username: {username}}) RETURN user.username AS username, user.name AS name, user.email AS email, user.registered AS registered, user.admin AS admin, user.type AS type, user.code AS code",
			params: {
				username: username
			}
		}).then(function (results) {
			if (results.length == 0) {
				results = null;
			}
			else {
				results = results[0];
				if (!results.email) {
					results.email = `${results.username}@gfacademy.org`
				}
			}
			response.json(results);
		}).catch(common.handleError.bind(response));
	})
	.put(postParser, function (request, response) {
		// Generate a unique code for this user
		var code = crypto.randomBytes(16).toString("hex");
		var name = request.body.name;
		var username = request.params.username;
		if (!name || !username) {
			response.json({ "success": false, "message": "Please enter both the user's name and username" });
			return;
		}
		name = name.toString().trim();
		username = username.toString().toLowerCase().trim();
		if (!name || !username) {
			response.json({ "success": false, "message": "Please enter both the user's name and username" });
			return;
		}
		var isTeacher = !!request.body.teacher;
		var isAdmin = !!request.body.admin;
		db.cypherAsync({
			query: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
			params: {
				name: name,
				username: username,
				registered: false,
				type: isTeacher ? common.UserType.Teacher : common.UserType.Student,
				admin: isAdmin,
				code: code
			}
		}).then(function (results) {
			response.json({ "success": true, "message": "User successfully created" });
		}).catch(neo4j.ClientError, function () {
			response.json({ "success": false, "message": "A user with that username already exists" });
		}).catch(common.handleError.bind(response));
	})
	.delete(function (request, response) {
		var username = request.params.username;
		db.cypherAsync({
			query: "MATCH (user:User {username: {username}}) DETACH DELETE user",
			params: {
				username: username
			}
		}).then(function (results) {
			response.json({ "success": true, "message": "User deleted successfully" });
		}).catch(common.handleError.bind(response));
	});
router.route("/move/:name")
	.get(function (request, response) {
		var {name}: { name: string } = request.params;

		Promise.all([
			db.cypherAsync({
				"query": "MATCH (u:User) WHERE u.name = {name} OR u.username = {name} RETURN u.name AS name, u.username AS username, u.code AS code, u.registered AS registered",
				"params": {
					name: name
				}
			}),
			db.cypherAsync({
				"query": "MATCH(item:ScheduleItem {editable: true }) RETURN item.title AS title, item.start AS startTime, item.end AS endTime"
			}),
			db.cypherAsync({
				"query": `MATCH (u:User) WHERE u.name = {name} OR u.username = {name}
						  MATCH (u)-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type`,
				"params": {
					name: name
				}
			}),
			db.cypherAsync({
				"query": `MATCH (u:User) WHERE u.name = {name} OR u.username = {name}
						  MATCH (u)-[r:PRESENTS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type`,
				"params": {
					name: name
				}
			}),
			db.cypherAsync({
				"query": `MATCH (u:User) WHERE u.name = {name} OR u.username = {name}
						  MATCH (u)-[r:MODERATES]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type`,
				"params": {
					name: name
				}
			}),
		]).spread(function (users: User[], editablePeriods: any[], attends: any[], presents: any[], moderates: any[]) {
			if (users.length !== 1) {
				response.json({ "success": false, "message": "User not found" });
				return Promise.reject(new IgnoreError());
			}
			var user = users[0];

			function findByTime (item: any[], time: moment.Moment): any {
				for (let i = 0; i < item.length; i++) {
					if (time.isSame(moment(item[i].startTime))) {
						return item[i];
					}
				}
				return null;
			}
			function formatSession (item: any, mandatory: boolean = false): any {
				return {
					"title": {
						"formatted": item.title,
						"slug": item.slug || null
					},
					"time": {
						"start": {
							"raw": item.startTime,
							"formatted": moment(item.startTime).format(timeFormat)
						},
						"end": {
							"raw": item.endTime,
							"formatted": moment(item.endTime).format(timeFormat)
						}
					},
					"type": item.type || null,
					"mandatory": mandatory
				};
			}

			var periods = editablePeriods.map(function (period) {
				var startTime = moment(period.startTime);
				var presenting = findByTime(presents, startTime);
				if (presenting) {
					return formatSession(presenting, true);
				}
				var moderating = findByTime(moderates, startTime);
				if (moderating) {
					return formatSession(moderating, true);
				}
				var attending = findByTime(attends, startTime);
				if (attending) {
					return formatSession(attending);
				}
				period.title = "Free";
				return formatSession(period);
			});
			response.json({ "success": true, "data": periods, "user": user });
		}).catch(IgnoreError, function () {
			// Response has already been handled if this error is thrown
		}).catch(common.handleError.bind(response));
	})
	.post(postParser, function (request, response) {
		var {username, slugs}: { username: string, slugs: string[] } = request.body;
		Promise.all([
			db.cypherAsync({
				"query": "MATCH (u:User {username: {username}}) RETURN u.name AS name, u.username AS username, u.registered AS registered",
				"params": {
					username: username
				}
			}),
			db.cypherAsync({
				"query": "MATCH(item:ScheduleItem {editable: true }) RETURN item.title AS title, item.start AS startTime, item.end AS endTime"
			}),
			db.cypherAsync({
				"query": "MATCH (u:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type",
				"params": {
					username: username
				}
			}),
			db.cypherAsync({
				"query": "MATCH (u:User {username: {username}})-[r:PRESENTS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type",
				"params": {
					username: username
				}
			}),
			db.cypherAsync({
				"query": "MATCH (u:User {username: {username}})-[r:MODERATES]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type",
				"params": {
					username: username
				}
			}),
		]).spread(function (users: User[], editablePeriods: any[], attends: any[], presents: any[], moderates: any[]) {
			if (users.length !== 1) {
				response.json({ "success": false, "message": "User not found" });
				return Promise.reject(new IgnoreError());
			}
			var user = users[0];
			if (editablePeriods.length !== slugs.length) {
				response.json({ "success": false, "message": "Incorrect number of changes for editable periods" });
				return Promise.reject(new IgnoreError());
			}
			// Remove from already registered sessions
			return db.cypherAsync({
				"query": "MATCH (u:User {username: {username}})-[r:ATTENDS]->(s:Session) SET s.attendees = s.attendees - 1 DELETE r REMOVE u.hasFree, u.timeOfFree",
				"params": {
					username: username
				}
			});
		}).then(function () {
			return Promise.map(slugs, function (slug) {
				// Frees have null as their slug
				if (!slug)
					return;
				return db.cypherAsync({
					"query": `
								MATCH (user:User {username: {username}})
								MATCH (session:Session {slug: {slug}})
								CREATE (user)-[r:ATTENDS]->(session)
								SET session.attendees = session.attendees + 1
								SET user.registered = true`,
					"params": {
						username: username,
						slug: slug
					}
				});
			});
		}).then(function () {
			response.json({ "success": true, "message": "User moved successfully" });
		}).catch(IgnoreError, function () {
			// Response has already been handled if this error is thrown
		}).catch(common.handleError.bind(response));
	});
router.route("/session")
	.get(function (request, response) {
		db.cypherAsync({
			query: `MATCH (s:Session) RETURN
				s.title AS title,
				s.slug AS slug,
				s.description AS description,
				s.type AS type,
				s.location AS location,
				s.capacity AS capacity,
				s.attendees AS attendees,
				s.startTime AS startTime,
				s.endTime AS endTime
				ORDER BY s.startTime, lower(s.title)`
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
		var title = request.body.title;
		var slug = slugMaker(title, { "lower": true });
		var description = request.body.description;
		var location = request.body.location;
		var capacity = request.body.capacity;
		var sessionType = request.body.type;
		var periodID = request.body.periodID;
		var presenters = request.body.presenters;
		var moderator = request.body.moderator;
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		if (!title || !location || !sessionType || !periodID) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.toString().trim();
		if (description) {
			description = description.toString().trim();
		}
		else {
			description = null;
		}
		location = location.toString().trim();
		sessionType = sessionType.toString().trim();
		periodID = periodID.toString().trim();
		if (!title || !location || !sessionType) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		if (!isInteger(capacity) || capacity < 1) {
			response.json({ "success": false, "message": "Please enter a valid capacity" });
			return;
		}
		if (moderator) {
			moderator = moderator.toString().trim();
		}
		if (!Array.isArray(presenters) || presenters.length < 1) {
			response.json({ "success": false, "message": "Please add a presenter" });
			return;
		}
		if (moderator && sessionType !== "Panel") {
			response.json({ "success": false, "message": "Only panels can have a moderator" });
			return;
		}
		if (sessionType !== "Panel" && presenters.length > 1) {
			response.json({ "success": false, "message": "Only one presenter is allowed per session" });
			return;
		}
		if (!moderator && sessionType === "Panel") {
			response.json({ "success": false, "message": "Panels must have a moderator" });
			return;
		}
		presenters = presenters.map(function (presenter) {
			return presenter.name;
		});
		var allUsers = (!moderator) ? presenters : presenters.concat(moderator);
		var tx;
		// Make sure that all presenters and moderators actually exist
		db.cypherAsync({
			query: "MATCH (u:User) WHERE u.name IN { names } RETURN count(u) AS users",
			params: {
				names: allUsers
			}
		}).then(function (results) {
			if (allUsers.length !== results[0].users) {
				if (sessionType !== "Panel") {
					response.json({ "success": false, "message": "The presenter could not be found" });
				}
				else {
					response.json({ "success": false, "message": "The moderator or one or more presenters could not be found" });
				}
				return Promise.reject(new IgnoreError());
			}

			return db.cypherAsync({
				query: "MATCH (item:ScheduleItem {id: {id}, editable: true}) RETURN item.id AS id, item.start AS start, item.end AS end",
				params: {
					id: periodID
				}
			});
		}).then(function (period) {
			if (period.length !== 1) {
				response.json({ "success": false, "message": "A customizable period with that ID could not be found" });
				return Promise.reject(new IgnoreError());
			}

			tx = Promise.promisifyAll(db.beginTransaction());
			return tx.cypherAsync({
				query: `CREATE (session:Session {
					title: { title },
					slug: { slug },
					description: { description },
					type: { type },
					location: { location },
					capacity: { capacity },
					attendees: { attendees },
					startTime: { startTime },
					endTime: { endTime }
				})`,
				params: {
					title: title,
					slug: slug,
					description: description,
					location: location,
					capacity: capacity,
					attendees: 0,
					type: sessionType,
					startTime: period[0].start,
					endTime: period[0].end
				}
			});
		}).then(function (results) {
			return Promise.mapSeries(presenters, function (presenter) {
				return tx.cypherAsync({
					query: `
							MATCH (user:User {name: { name }})
							MATCH (session:Session {slug: { slug }})
							CREATE (user)-[r:PRESENTS]->(session)`,
					params: {
						name: presenter,
						slug: slug
					}
				});
			}).then(function () {
				if (moderator) {
					return tx.cypherAsync({
						query: `
							MATCH (user:User {name: { name }})
							MATCH (session:Session {slug: { slug }})
							CREATE (user)-[r:MODERATES]->(session)`,
						params: {
							name: moderator,
							slug: slug
						}
					});
				}
				else {
					return Promise.resolve();
				}
			});
		}).then(function (results) {
			return tx.commitAsync();
		}).then(function (results) {
			response.json({ "success": true, "message": "Session successfully created" });
		}).catch(neo4j.ClientError, function (err) {
			console.log(err);
			response.json({ "success": false, "message": "A session with that title already exists" });
		}).catch(IgnoreError, function () {
			// Response has already been handled if this error is thrown
		}).catch(function (err) {
			if (tx) {
				tx.rollback(function () {
					common.handleError.bind(response)(err);
				});
			}
		});
	});
router.route("/session/:slug")
	.get(function (request, response) {
		var slug = request.params.slug;
		db.cypherAsync({
			queries: [{
				query: `MATCH (s:Session {slug: {slug}}) RETURN
					s.title AS title,
					s.slug AS slug,
					s.description AS description,
					s.type AS type,
					s.location AS location,
					s.capacity AS capacity,
					s.attendees AS attendees,
					s.startTime AS startTime,
					s.endTime AS endTime`,
				params: {
					slug: slug
				}
			}, {
				query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
				params: {
					slug: slug
				}
			}, {
				query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name",
				params: {
					slug: slug
				}
			}]
		}).then(function (results) {
			var sessions = results[0];
			if (sessions.length == 0) {
				response.json(null);
			}
			else {
				response.json({
					"title": {
						"formatted": sessions[0].title,
						"slug": sessions[0].slug
					},
					"description": sessions[0].description,
					"type": sessions[0].type,
					"location": sessions[0].location,
					"capacity": {
						"total": sessions[0].capacity,
						"filled": sessions[0].attendees
					},
					"time": {
						"start": {
							"raw": sessions[0].startTime,
							"formatted": moment(sessions[0].startTime).format(timeFormat)
						},
						"end": {
							"raw": sessions[0].endTime,
							"formatted": moment(sessions[0].endTime).format(timeFormat)
						},
						"date": moment(sessions[0].startTime).format(dateFormat)
					},
					"presenters": results[1],
					"moderator": (results[2].length !== 0) ? results[2][0] : null
				});
			}
		}).catch(common.handleError.bind(response));
	})
	.delete(function (request, response) {
		var slug = request.params.slug;
		db.cypherAsync({
			query: "MATCH (s:Session {slug: {slug}}) DETACH DELETE s",
			params: {
				slug: slug
			}
		}).then(function (results) {
			response.json({ "success": true, "message": "Session deleted successfully" });
		}).catch(common.handleError.bind(response));
	});
router.route("/session/:slug/attendance").get(function (request, response) {
	fs.readFileAsync("public/components/admin/session.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});
router.route("/session/:slug/attendance/data").get(function (request, response) {
	var slug = request.params.slug;
	db.cypherAsync({
		"query": "MATCH (user:User)-[r:ATTENDS]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name, user.type AS type ORDER BY last(split(user.name, \" \"))",
		"params": {
			slug: slug
		}
	}).then(function (results) {
		var students = results.filter(function (user) {
			return user.type === common.UserType.Student;
		});
		var faculty = results.filter(function (user) {
			return user.type === common.UserType.Teacher;
		});
		response.json({
			"faculty": faculty,
			"students": students
		});
	}).catch(common.handleError.bind(response));
});
router.route("/schedule")
	.get(function (request, response) {
		db.cypherAsync({
			query: "MATCH (item:ScheduleItem) RETURN item.id AS id, item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable ORDER BY item.start"
		}).then(function (results) {
			response.json(results.map(function (item) {
				var startTime = item.start;
				delete item.start;
				var endTime = item.end;
				delete item.end;
				item.time = {
					"start": {
						"raw": startTime,
						"formatted": moment(startTime).format(timeFormat)
					},
					"end": {
						"raw": endTime,
						"formatted": moment(endTime).format(timeFormat)
					}
				};
				return item;
			}));
		}).catch(common.handleError.bind(response));
	})
	.patch(postParser, function (request, response) {
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		var { id, title, startTime, duration, location, customizable }: { id: string, title: string, startTime: string, duration: number, location: string, customizable: boolean } = request.body;
		if (!id) {
			response.json({ "success": false, "message": "Missing ID" });
			return;
		}
		if (!title || !startTime || !duration || typeof customizable !== "boolean") {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.toString().trim();
		startTime = startTime.toString().trim();
		if (location) {
			location = location.toString().trim();
		}
		else {
			location = null;
		}
		if (!isInteger(duration) || duration < 1) {
			response.json({ "success": false, "message": "Please enter a valid duration" });
			return;
		}
		common.getSymposiumDate().then(function (date: moment.Moment) {
			var start = moment(startTime, timeFormat);
			start.set("year", date.get("year"));
			start.set("month", date.get("month"));
			start.set("date", date.get("date"));
			var end = start.clone().add(duration, "minutes");

			if (!start.isValid() || !end.isValid()) {
				response.json({ "success": false, "message": "Invalid start time or duration" });
				return Promise.reject(new IgnoreError());
			}

			return db.cypherAsync({
				query: "MATCH (item:ScheduleItem {id: {id}}) SET item.title = {title}, item.start = {startTime}, item.end = {endTime}, item.location = {location}, item.editable = {customizable}",
				params: {
					id: id,
					title: title,
					startTime: start.format(),
					endTime: end.format(),
					location: location,
					customizable: customizable
				}
			});
		}).catch(IgnoreError, function () {
			// Response has already been handled if this error is thrown
		}).then(function (results) {
			response.json({ "success": true, "message": "Updated successfully" });
		}).catch(common.handleError.bind(response));
	});

// Very similar to schedule code in data.ts (keep the two roughly in sync if changes are made)
function getScheduleForUser(user: { name: string; username: string; registered: boolean; }): Promise<{ "name": string; "schedule": any[] }> {
	if (!user.registered) {
		// Generalized schedule for unregistered users
		return db.cypherAsync({
			query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
		}).then(function (results) {
			results = results.map(function (item) {
				var startTime = item.start;
				delete item.start;
				var endTime = item.end;
				delete item.end;
				item.time = {
					"start": {
						"raw": startTime,
						"formatted": moment(startTime).format(timeFormat)
					},
					"end": {
						"raw": endTime,
						"formatted": moment(endTime).format(timeFormat)
					}
				};
				return item;
			});
			return {
				"name": user.name,
				"schedule": results
			};
		});
	}
	else {
		// Schedule for registered users
		return db.cypherAsync({
			"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS start, s.endTime AS end, s.location AS location, s.type AS type, s.description AS description, true AS editable",
			"params": {
				username: user.username
			}
		}).then(function (attendingSessions: any[]) {
			return Promise.map(attendingSessions, function (attendingSession) {
				return db.cypherAsync({
					"query": "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}}) RETURN user.name AS name, s.slug AS slug",
					"params": {
						slug: attendingSession.slug
					}
				});
			}).then(function (sessionsWithNames) {
				return db.cypherAsync({
					query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
				}).then(function (items) {
					return Promise.resolve([items, attendingSessions, sessionsWithNames]);
				});
			});
		}).spread(function (items, sessions, sessionsWithNames) {
			function formatter(item) {
				var startTime = item.start;
				delete item.start;
				var endTime = item.end;
				delete item.end;
				item.time = {
					"start": {
						"raw": startTime,
						"formatted": moment(startTime).format(timeFormat)
					},
					"end": {
						"raw": endTime,
						"formatted": moment(endTime).format(timeFormat)
					}
				};
				return item;
			}
			// Flatten array
			sessionsWithNames = [].concat.apply([], sessionsWithNames);
			for (let i = 0; i < items.length; i++) {
				// Insert registration choices into schedule at editable periods
				if (items[i].editable) {
					let set = false;
					for (let j = 0; j < sessions.length; j++) {
						if (moment(sessions[j].start).isSame(moment(items[i].start))) {
							items[i] = sessions[j];
							set = true;
							let people = [];
							for (let k = 0; k < sessionsWithNames.length; k++) {
								if (sessionsWithNames[k].slug === sessions[j].slug) {
									people.push(sessionsWithNames[k].name);
								}
							}
							// Sort people by last name
							people = people.sort(function (a, b) {
								var aSplit = a.toLowerCase().split(" ");
								var bSplit = b.toLowerCase().split(" ");
								a = aSplit[aSplit.length - 1];
								b = bSplit[bSplit.length - 1];
								if (a < b) return -1;
								if (a > b) return 1;
								return 0;
							});
							items[i].people = people.join(", ");
							// Return type of form "Global" or "Science" instead of including "session" at the end
							if (items[i].type)
								items[i].type = items[i].type.split(" ")[0];
							break;
						}
					}
					if (!set) {
						// Couldn't find registered session for this editable time so it must be a free
						items[i].title = "Free";
					}
				}
			}
			return {
				"name": user.name,
				"schedule": items.map(formatter)
			};
		});
	}
}
router.route("/schedule/:filter").get(function (request, response) {
	fs.readFileAsync("public/components/admin/schedule.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});
router.route("/schedule/:filter/data").get(function (request, response) {
	var {filter}: { filter: string } = request.params;
	if (!filter) {
		filter = "all";
	}
	filter = filter.toString().toLowerCase();
	if (filter === "all") {
		var criteria = "";
	}
	else if (filter === "freshman") {
		var criteria = "grade: 9";
	}
	else if (filter === "sophomore") {
		var criteria = "grade: 10";
	}
	else if (filter === "junior") {
		var criteria = "grade: 11";
	}
	else if (filter === "senior") {
		var criteria = "grade: 12";
	}
	else {
		var criteria = "type: {type}";
	}
	var type = common.getUserType(filter);
	db.cypherAsync({
		"query": `MATCH (u:User {${criteria}}) RETURN u.name AS name, u.username AS username, u.registered AS registered ORDER BY last(split(u.name, " "))`,
		"params": {
			type: common.getUserType(filter)
		}
	}).then(function (users) {
		return Promise.map(users, function (user: { name: string; username: string; registered: boolean; }) {
			return getScheduleForUser(user);
		});
	}).then(function (results) {
		response.json(results);
	}).catch(common.handleError.bind(response));
});
router.route("/schedule/user/:name").get(function (request, response) {
	var {name}: { name: string } = request.params;
	fs.readFileAsync("public/components/admin/schedule.html", "utf8")
		.then(function (html: string) {
			response.send(html);
		})
		.catch(common.handleError.bind(response));
});
router.route("/schedule/user/:name/data").get(function (request, response) {
	var {name}: { name: string } = request.params;

	db.cypherAsync({
		"query": "MATCH (u:User) WHERE u.name = {name} OR u.username = {name} RETURN u.name AS name, u.username AS username, u.registered AS registered",
		"params": {
			name: name
		}
	}).then(function (user) {
		if (user.length !== 1) {
			return getScheduleForUser({
				"name": "Unknown user",
				"username": "unknown",
				"registered": false
			});
		}
		else {
			return getScheduleForUser(user[0]);
		}
	}).then(function (schedule) {
		// Wrap in an array because the schedule displayer is used for both lists of schedules and individual schedules
		response.json([schedule]);
	}).catch(common.handleError.bind(response));
});
router.route("/schedule/switch").patch(postParser, function (request, response) {
	var {id1, id2}: { id1: string, id2: string } = request.body;
	if (!id1 || !id2) {
		response.json({ "success": false, "message": "Missing IDs" });
		return;
	}
	Promise.map([id1, id2], function (id) {
		return db.cypherAsync({
			query: "MATCH (item:ScheduleItem {id: {id}}) RETURN item.id AS id, item.start AS start, item.end AS end",
			params: {
				id: id
			}
		});
	}).spread(function (item1, item2) {
		/*if (item1.length !== 1 || !item2.length !== 1) {

		}*/
	});
});
router.route("/schedule/date")
	.get(function (request, response) {
		common.getSymposiumDate().then(function (date: moment.Moment) {
			response.json({
				"formatted": date.format("MMMM Do, YYYY")
			});
		}).catch(common.handleError.bind(response));
	})
	.patch(postParser, function (request, response) {
		var rawDate: string = request.body.date;
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		rawDate = rawDate.toString().trim();
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		var date: moment.Moment = moment(rawDate, dateFormat);
		if (!date.isValid()) {
			response.json({ "success": false, "message": "Invalid date input" });
			return;
		}

		// Get all schedule items and sessions
		db.cypherAsync({
			queries: [{
				query: "MATCH (item:ScheduleItem) RETURN item.id AS id, item.start AS start, item.end AS end"
			}, {
				query: "MATCH (s:Session) RETURN s.slug AS slug, s.startTime AS start, s.endTime AS end"
			}]
		}).spread(function (scheduleItems: any[], sessions: any[]) {
			scheduleItems.map(function (item) {
				var start = moment(item.start);
				var end = moment(item.end);
				start.set("year", date.get("year"));
				start.set("month", date.get("month"));
				start.set("date", date.get("date"));
				end.set("year", date.get("year"));
				end.set("month", date.get("month"));
				end.set("date", date.get("date"));
				item.start = start.format();
				item.end = end.format();
				return item;
			});
			sessions.map(function (session) {
				var start = moment(session.start);
				var end = moment(session.end);
				start.set("year", date.get("year"));
				start.set("month", date.get("month"));
				start.set("date", date.get("date"));
				end.set("year", date.get("year"));
				end.set("month", date.get("month"));
				end.set("date", date.get("date"));
				session.start = start.format();
				session.end = end.format();
				return session;
			});
			var queries: any[] = [{
				query: "MATCH (c:Constant) WHERE c.date IS NOT NULL SET c.date = { date } RETURN c",
				params: {
					date: date.format("YYYY-MM-DD")
				}
			}];
			queries = queries.concat(scheduleItems.map(function (item) {
				return {
					query: "MATCH (item:ScheduleItem {id: {id}}) SET item.start = {start}, item.end = {end}",
					params: {
						id: item.id,
						start: item.start,
						end: item.end
					}
				};
			}));
			queries = queries.concat(sessions.map(function (session) {
				return {
					query: "MATCH (s:Session {slug: {slug}}) SET s.startTime = {start}, s.endTime = {end}",
					params: {
						slug: session.slug,
						start: session.start,
						end: session.end
					}
				};
			}));
			return db.cypherAsync({
				queries: queries
			});
		}).then(function (results) {
			response.json({ "success": true, "message": "Symposium date changed successfully" });
		}).catch(common.handleError.bind(response));
	});
router.route("/registration/email").get(function (request, response) {
	Promise.all([
		db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationEmailTime IS NOT NULL RETURN c"
		}),
		db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.scheduleEmailTime IS NOT NULL RETURN c"
		})
	]).spread(function (registration, schedule) {
		var registrationEmailTime: moment.Moment = moment(registration[0].c.properties.registrationEmailTime);
		var scheduleEmailTime: moment.Moment = moment(schedule[0].c.properties.scheduleEmailTime);
		response.json({
			"registration": {
				"raw": registration[0].c.properties.registrationEmailTime,
				"formatted": `${registrationEmailTime.format(dateFormat)} at ${registrationEmailTime.format(timeFormat)}`
			},
			"schedule": {
				"raw": schedule[0].c.properties.scheduleEmailTime,
				"formatted": `${scheduleEmailTime.format(dateFormat)} at ${scheduleEmailTime.format(timeFormat)}`
			}
		});
	}).catch(common.handleError.bind(response));
});
router.route("/registration/email/registration").post(function (request, response) {
	var totalRecipients = 0;
	// Get emails to send to
	Promise.all([
		db.cypherAsync({
			"query": "MATCH (u:User) RETURN u.name AS name, u.username AS username, u.email AS email, u.code AS code"
		}),
		common.getSymposiumDate()
	]).spread(function (results, date: moment.Moment) {
		totalRecipients = results.length;
		return Promise.mapSeries(results, function (user: any) {
			var email = (!!user.email) ? user.email : `${user.username}@gfacademy.org`;
			var emailToSend = new sendgrid.Email({
				to: email,
				from: "registration@wppsymposium.org",
				fromname: "GFA World Perspectives Symposium",
				subject: "GFA WPP Symposium Registration",
				text:
				`Hi ${user.name},

This year's World Perspectives Symposium will take place on ${date.format(dateFormat)}. To login and register for presentations, visit the following link:

https://wppsymposium.org/user/login/${user.code}

Be sure to register for presentations soon before they fill up. You can visit the link at any time after you've registered to view your schedule. If you miss the registration cut-off date, your schedule will be automatically generated based on availability.

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
			});
			return sendgrid.sendAsync(emailToSend);
		});
	}).then(function (results) {
		return db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationEmailTime IS NOT NULL SET c.registrationEmailTime = {time} RETURN c",
			params: {
				time: moment().format()
			}
		});
	}).then(function (results) {
		response.json({ "success": true, "message": `Sent registration emails to ${totalRecipients} recipients` });
	}).catch(common.handleError.bind(response));
});
router.route("/registration/email/schedule").post(function (request, response) {
	var totalRecipients = 0;
	// Get emails to send to
	Promise.all([
		db.cypherAsync({
			"query": "MATCH (u:User) RETURN u.name AS name, u.username AS username, u.email AS email, u.code AS code, u.registered AS registered"
		}),
		common.getSymposiumDate()
	]).spread(function (results, date: moment.Moment) {
		totalRecipients = results.length;
		return Promise.mapSeries(results, function (user: any) {
			return getScheduleForUser({
				"name": user.name,
				"username": user.username,
				"registered": user.registered
			}).get("schedule").then(function (schedule: any[]) {
				// Generate schedule for email body
				var scheduleFormatted = schedule.map(function (scheduleItem) {
					return `${scheduleItem.time.start.formatted} to ${scheduleItem.time.end.formatted}${!!scheduleItem.location ? " in " + scheduleItem.location : ""}: ${scheduleItem.title}${!!scheduleItem.type ? ` (${scheduleItem.type})` : ""}`;
				}).join("\n\n");

				var email = (!!user.email) ? user.email : `${user.username}@gfacademy.org`;
				var emailToSend = new sendgrid.Email({
					to: email,
					from: "registration@wppsymposium.org",
					fromname: "GFA World Perspectives Symposium",
					subject: "Your symposium schedule",
					text:
					`Hi ${user.name},

Here is your schedule for this year's World Perspectives Symposium taking place on ${date.format("dddd")} ${date.format(dateFormat)}:

${scheduleFormatted}

You can also visit the following link to view and print a more detailed schedule: https://wppsymposium.org/user/login/${user.code}

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
				});
				return sendgrid.sendAsync(emailToSend);
			});
		});
	}).then(function (results) {
		return db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.scheduleEmailTime IS NOT NULL SET c.scheduleEmailTime = {time} RETURN c",
			params: {
				time: moment().format()
			}
		});
	}).then(function (results) {
		response.json({ "success": true, "message": `Sent schedule emails to ${totalRecipients} recipients` });
	}).catch(common.handleError.bind(response));
});
router.route("/registration/open")
	.get(function(request, response) {
		db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL RETURN c"
		}).then(function (result) {
			var registrationOpen: boolean = result[0].c.properties.registrationOpen;
			response.json({
				"open": registrationOpen
			});
		}).catch(common.handleError.bind(response));
	})
	.put(postParser, function (request, response) {
		var {open}: { open: boolean } = request.body;
		if (typeof open !== "boolean") {
			response.json({ "success": false, "message": "Invalid open value" });
			return;
		}
		db.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL SET c.registrationOpen = {open} RETURN c",
			params: {
				open: open
			}
		}).then(function (result) {
			response.json({ "success": true, "message": `Registration is now ${open ? "open" : "closed"}` });
		}).catch(common.handleError.bind(response));
	});
router.route("/registration/stats")
	.get(function (request, response) {
		db.cypherAsync({
			query: "MATCH (u:User) WHERE u.type = 0 OR u.type = 1 RETURN u.registered AS registered, u.type AS type"
		}).then(function (results) {
			var registeredStudents = 0;
			var totalStudents = 0;
			var registeredTeachers = 0;
			var totalTeachers = 0;
			results.forEach(function (result) {
				if (result.type === common.UserType.Student) {
					totalStudents++;
					if (result.registered)
						registeredStudents++;
				}
				if (result.type === common.UserType.Teacher) {
					totalTeachers++;
					if (result.registered)
						registeredTeachers++;
				}
			});
			response.json({
				"students": {
					"total": totalStudents,
					"registered": registeredStudents
				},
				"faculty": {
					"total": totalTeachers,
					"registered": registeredTeachers
				}
			});
		}).catch(common.handleError.bind(response));
	});
router.route("/registration/auto").post(function (request, response) {
	var totalUsers = 0;
	// Get all unregistered users and all sessions first
	Promise.all([
		db.cypherAsync({
			query: "MATCH (u:User {registered: false}) RETURN u.username AS username"
		}),
		db.cypherAsync({
			query: "MATCH(item:ScheduleItem {editable: true }) RETURN item.title AS title, item.start AS startTime, item.end AS endTime"
		}),
		db.cypherAsync({
			query: "MATCH (s:Session) RETURN s.slug AS slug, s.attendees AS attendees, s.capacity AS capacity, s.startTime AS startTime, s.endTime AS endTime"
		})
	]).spread(function (users: User[], editablePeriods: any[], sessions: any[]) {
		totalUsers = users.length;
		Promise.each(editablePeriods, function (period) {
			// Shuffle users for each period
			function shuffle(array) {
				let counter = array.length;

				// While there are elements in the array
				while (counter > 0) {
					// Pick a random index
					let index = Math.floor(Math.random() * counter);

					// Decrease counter by 1
					counter--;

					// And swap the last element with it
					let temp = array[counter];
					array[counter] = array[index];
					array[index] = temp;
				}

				return array;
			}
			users = shuffle(users);
			// Find non-full sessions that occur at this time
			var availableSessions = [];
			function updateAvailableSessions() {
				availableSessions = sessions.filter(function (session) {
					if (session.attendees < session.capacity && moment(session.startTime).isSame(moment(period.startTime))) {
						return true;
					}
					return false;
				});
				if (availableSessions.length < 1) {
					// Not enough sessions
					console.warn(`Not enough capacity at ${moment(period.startTime).format(timeFormat)} to autoregister`);
				}
				function sortSessions(sessions: any[]): any[] {
					return sessions.sort(function (a, b) {
						return a.attendees - b.attendees;
					});
				}
				availableSessions = sortSessions(availableSessions);
			}
			updateAvailableSessions();
			// Find the unregistered users that have registered for this period already (partially completed registration) to filter them out of needing to be autoregistered
			return db.cypherAsync({
				query: "MATCH (u:User {registered: false})-[r:ATTENDS]->(s:Session {startTime: {startTime}}) RETURN u.username AS username",
				params: {
					startTime: period.startTime
				}
			}).then(function (attendingUsers: User[]) {
				var attendingUsernames = attendingUsers.map(function (attendingUser) {
					return attendingUser.username;
				});
				var remainingUsers = users.filter(function (user) {
					return attendingUsernames.indexOf(user.username) === -1;
				});
				Promise.each(remainingUsers, function (user: User) {
					updateAvailableSessions();
					// Check if this user moderates or presents a session at this time period
					return Promise.all([
						db.cypherAsync({
							query: "MATCH (u:User {username: {username}})-[r:PRESENTS]->(s:Session {startTime: {startTime}}) RETURN s.slug AS slug",
							params: {
								username: user.username,
								startTime: period.startTime
							}
						}),
						db.cypherAsync({
							query: "MATCH (u:User {username: {username}})-[r:MODERATES]->(s:Session {startTime: {startTime}}) RETURN s.slug AS slug",
							params: {
								username: user.username,
								startTime: period.startTime
							}
						})
					]).spread(function (presenting: any[], moderating: any[]) {
						var registerSlug = null;
						var attendanceCount = 1;
						if (presenting.length > 0) {
							registerSlug = presenting[0].slug;
							attendanceCount = 0;
						}
						else if (moderating.length > 0) {
							registerSlug = moderating[0].slug;
							attendanceCount = 0;
						}
						else {
							registerSlug = availableSessions[0].slug;
							availableSessions[0].attendees++;
						}
						// Register this user
						return db.cypherAsync({
							query: `
								MATCH (user:User {username: {username}})
								MATCH (session:Session {slug: {slug}})
								CREATE (user)-[r:ATTENDS]->(session)
								SET session.attendees = session.attendees + {attendanceCount}`,
							params: {
								username: user.username,
								slug: registerSlug,
								attendanceCount: attendanceCount
							}
						});
					});
				});
			});
		});
	}).then(function () {
		// Set all users as registered
		return db.cypherAsync({
			query: "MATCH (u:User {registered: false}) SET u.registered = true"
		});
	}).then(function () {
		response.json({ "success": true, "message": `Successfully autoregistered ${totalUsers} users` });
	}).catch(IgnoreError, function () {
		// Response has already been handled if this error is thrown
	}).catch(common.handleError.bind(response));
});

export = router;