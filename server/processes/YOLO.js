const forever = require('forever-monitor');
const config = require('../../config.json');
const simulation30FPSDetectionsData = require('../../static/placeholder/alexeydetections30FPS.json');
const fs = require('fs');
const path = require('path');
const http = require('http');
const killable = require('killable');
const mjpegServer = require('mjpeg-server');
const {
  performance
} = require('perf_hooks');

let YOLO = {
  isStarting: false,
  isStarted: false,
  isInitialized: false,
  process: null,
  simulationMode: false,
  simulationMJPEGServer: null,
  simulationJSONHTTPStreamServer: null,
  currentVideoParams: ""
};

module.exports = {
  init: function(simulationMode, videoParams = null) {

    YOLO.simulationMode = simulationMode;

    if(!YOLO.simulationMode) {
      var yoloParams = config.NEURAL_NETWORK_PARAMS[config.NEURAL_NETWORK];
      var videoParams = videoParams || config.VIDEO_INPUTS_PARAMS[config.VIDEO_INPUT];
      YOLO.currentVideoParams = videoParams

      var darknetCommand = [];
      var initialCommand = ['./uselib', yoloParams.data , yoloParams.cfg, yoloParams.weights]

      darknetCommand = initialCommand.concat(videoParams);
      
      YOLO.process = new (forever.Monitor)(darknetCommand,{
        max: Number.POSITIVE_INFINITY,
        cwd: config.PATH_TO_YOLO_DARKNET,
        env: { 'LD_LIBRARY_PATH': './' },
        killTree: true
      });

      YOLO.process.on("start", () => {
        console.log('Process YOLO started');
        YOLO.isStarted = true;
        YOLO.isStarting = false;
      });

      YOLO.process.on("restart", () => {
        // Forever 
        console.log("Restart YOLO");
      })

      YOLO.process.on("error", (err) => {
        console.log('Process YOLO error');
        console.log(err);
      });

      YOLO.process.on("exit", (err) => {
        console.log('Process YOLO exit');
        //console.log(err);
      });
    }

    console.log('Process YOLO initialized');
    YOLO.isInitialized = true;

    // TODO handle other kind of events
    // https://github.com/foreverjs/forever-monitor#events-available-when-using-an-instance-of-forever-in-nodejs
  },

  getStatus: function() {
    return {
      isStarting: YOLO.isStarting,
      isStarted: YOLO.isStarted
    }
  },

  getVideoParams: function() {
    return YOLO.currentVideoParams;
  },

  start: function() {
    // Do not start it twice
    if(YOLO.isStarted || YOLO.isStarting) {
      console.log('already started');
      return;
    }
    
    YOLO.isStarting = true;

    if(YOLO.simulationMode) {
      setTimeout(() => {
        // Simulate 5s to start yolo
        this.startYOLOSimulation();
      }, 5000);
    } else {
      if(!YOLO.isStarted) {
        YOLO.process.start();
      }
    }
  },

  stop: function() {
    return new Promise((resolve, reject) => {
      if(YOLO.simulationMode && YOLO.simulationServer) {
        YOLO.simulationServer.kill(function () {
          YOLO.isStarted = false;
          resolve();
        });
      } else {
        if(YOLO.isStarted) {
          YOLO.process.once("stop", () => {
            console.log('Process YOLO stopped');
            YOLO.isStarted = false;
            resolve();
          });
          YOLO.process.stop();
        }
      }
    });
  },

  restart() {
    if(!YOLO.simulationMode) {
      console.log('Process YOLO restart');
      this.stop().then(() => {
        this.start();
      });

    } else {
      YOLO.simulationJSONHTTPStreamServer.kill();
      YOLO.simulationMJPEGServer.kill();
      setTimeout(() => {
        this.startYOLOSimulation()
      }, 5000)
    }
  },

  formatDetectionsToNewDarknetFormat: function(detection) {
    return {
      frame_id: detection.frame_id,
      video_size: {
        width: 640,
        height: 360
      },
      objects: detection.objects.map((object) => {
        return {
          class_id: object.class_id,
          name: object.name,
          absolute_coordinates: {
            center_x: (object.relative_coordinates.center_x - object.relative_coordinates.width / 2) * 640,
            center_y: (object.relative_coordinates.center_y - object.relative_coordinates.height / 2) * 360,
            width: object.relative_coordinates.width * 640,
            height: object.relative_coordinates.height * 360
          },
          confidence: object.confidence
        }
      })
    }
  },

  startYOLOSimulation: function() {
    var self = this;
    /**
     *   Used in Dev mode for faster development
     *     - Simulate a MJPEG stream on port 8090
     *     - Update opendatacam tracker on each frame
     */
    var frameNb = 16;
    var mjpegReqHandler = null;
    var timer = null;
    var dataThisFrame = [];
    var JSONStreamRes = null;
    
    console.log("Start HTTP JSON Stream server");

    YOLO.simulationJSONHTTPStreamServer = http.createServer(function(req, res) {
      console.log("Got request on JSON Stream server started");
      JSONStreamRes = res;
      // Send one frame on the JSON stream to start things
      var detectionsDataForThisFrame = self.formatDetectionsToNewDarknetFormat(simulation30FPSDetectionsData.find((detection) => detection.frame_id === frameNb))
      JSONStreamRes.write(JSON.stringify(detectionsDataForThisFrame));
    }).listen(8070);


    killable(YOLO.simulationJSONHTTPStreamServer);
    console.log("Start MJPEG server");
    

    YOLO.simulationMJPEGServer = http.createServer(function(req, res) {
      console.log("Got request on MJPEG server");

      if(mjpegReqHandler) {
        mjpegReqHandler.close();
        clearInterval(timer);
      }
      mjpegReqHandler = mjpegServer.createReqHandler(req, res);
      timer = setInterval(() => {
        updateJPG();
        if(JSONStreamRes) {
          // Modify format of alexeydetections30FPS to match new format since ODCv3 Upgrade
          var detectionsDataForThisFrame = self.formatDetectionsToNewDarknetFormat(simulation30FPSDetectionsData.find((detection) => detection.frame_id === frameNb))
          JSONStreamRes.write(JSON.stringify(detectionsDataForThisFrame));
        } else {
          console.log("JSONStream connexion not opened yet");
        }
      }, 34);

      function updateJPG() {
        fs.readFile(path.join(__dirname, '../../static/placeholder/frames') + "/" + String(frameNb).padStart(3, '0') + '.jpg', sendJPGData);
        frameNb++;
      }

      function sendJPGData(err, data) {
        if(err) {
          console.log(err);
        }
        mjpegReqHandler.write(data, function() {
          checkIfFinished();
        });
      }

      function checkIfFinished() {
        if (frameNb > 451) {
          // clearInterval(timer);
          // mjpegReqHandler.close();
          console.log('Reset stream');
          frameNb = 16;
        }
      }
    }).listen(8090);
    killable(YOLO.simulationMJPEGServer);
  },
}
